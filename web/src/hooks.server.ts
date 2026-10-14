import { type Handle, type ServerInit } from '@sveltejs/kit';
import {
	handleWsMessage,
	parseWsPath,
	TRUSTED_ORIGIN,
	resizePane,
	socketOriginAllowed,
	type WsClient,
	type WsMessageHandlers
} from '$shared/server/ws-handlers.js';
import { browserOriginAllowed } from '$shared/server/browser-view.js';
import {
	browserWsManager,
	sessionsWsManager,
	terminalWsManager,
	transcriptWsManager
} from '$lib/server/ws-managers.js';
import { ensurePushMonitor } from '$lib/server/push.js';
import { ensureFleetState } from '$lib/server/fleet.js';
import {
	admitRelay,
	openRelayUpstream,
	parseFleetPath,
	relayRequest,
	type RelaySocket
} from '$shared/server/fleet-relay.js';
import { machineUrl } from '$lib/server/discover';
import { MACHINE_ID } from '$lib/server/instance';

// Pushes go to phones with every tab closed, so their events are watched from
// the moment the server starts rather than when the first page connects.
// The fleet state likewise follows the other machines whether or not a page is open.
export const init: ServerInit = () => {
	ensurePushMonitor();
	ensureFleetState();
};

/**
 * What a socket was upgraded for: its channel, and the pane, session (and
 * agent) or browser tab it reads. A `relay` socket is a page's socket to
 * another machine, joined to that machine's at `base` + `target`.
 */
type WsData = {
	type: 'sessions' | 'terminal' | 'transcript' | 'browser' | 'relay';
	target?: string;
	agent?: string;
	base?: string;
	fleet?: boolean;
};

// Map to store WebSocket data (type, target, and client wrapper for proper cleanup)
const wsDataMap = new WeakMap<WebSocket, WsData & { client: WsClient; upstream?: RelaySocket }>();

// Handle function for SvelteKit
/**
 * Another claude-mux on the tailnet may read this one from the browser: the
 * sidebar shows every machine's sessions at once, which means the page served
 * by one host fetches and streams from the others. Browsers allow that only
 * when the other host says so, and it says so for tailnet origins alone —
 * `*.ts.net`, plus the loopback names a dev server answers on. There is no
 * login to protect here beyond the tailnet itself, so the tailnet is the line
 * (`TRUSTED_ORIGIN`).
 */
function corsHeaders(origin: string): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '600',
		Vary: 'Origin'
	};
}

export const handle: Handle = async ({ event, resolve }) => {
	const origin = event.request.headers.get('origin');
	const fleet = parseFleetPath(event.url.pathname);
	const crossSite = !!origin && origin !== event.url.origin && TRUSTED_ORIGIN.test(origin);
	if (crossSite && event.request.method === 'OPTIONS' && event.url.pathname.startsWith('/api/')) {
		return new Response(null, { status: 204, headers: corsHeaders(origin) });
	}

	// Check for WebSocket upgrade
	const connectionHeader = event.request.headers.get('connection');
	const upgradeHeader = event.request.headers.get('upgrade');

	if (
		connectionHeader?.toLowerCase().includes('upgrade') &&
		upgradeHeader?.toLowerCase() === 'websocket'
	) {
		const url = new URL(event.request.url);
		const host = event.request.headers.get('host');

		if (fleet) {
			const base = await admitRelay(origin, host, fleet.machine, machineUrl);
			if (typeof base !== 'string') return base;
			// @ts-expect-error - platform is provided by svelte-adapter-bun
			await event.platform.server.upgrade(event.platform.request, {
				data: { type: 'relay', base, target: `${fleet.path}${url.search}` } satisfies WsData
			});
			return new Response(null, { status: 101 });
		}

		const parsed = parseWsPath(url.pathname, url.search);

		// A WebSocket is not held to CORS, so the origin is checked here. The
		// browser stream takes input for a logged-in browser, and only this
		// server's own page may open it.
		const allowed = parsed?.type === 'browser' ? browserOriginAllowed(origin, host) : socketOriginAllowed(origin, host);
		if (parsed && !allowed) {
			return new Response('Forbidden', { status: 403 });
		}

		if (parsed) {
			// @ts-expect-error - platform is provided by svelte-adapter-bun
			await event.platform.server.upgrade(event.platform.request, {
				data: parsed
			});
			return new Response(null, { status: 101 });
		}
	}

	if (fleet) return relayRequest(event.request, fleet, machineUrl, MACHINE_ID);

	const response = await resolve(event);
	// The remote browser's tabs are this server's own page's business, never another origin's.
	if (crossSite && event.url.pathname.startsWith('/api/') && !event.url.pathname.startsWith('/api/browser/')) {
		for (const [name, value] of Object.entries(corsHeaders(origin))) response.headers.set(name, value);
	}
	return response;
};

// WebSocket handlers for svelte-adapter-bun (passed straight to Bun.serve).
export const websocket = {
	/**
	 * Transcript snapshots are hundreds of kilobytes of JSON, and the phone
	 * reading them is usually on the far side of a tailnet. The payloads are
	 * highly repetitive, so deflate takes them down by roughly an order of
	 * magnitude; the terminal's small frames pay a negligible amount of CPU.
	 */
	perMessageDeflate: true,
	open(ws: WebSocket & { data?: WsData }) {
		const data = ws.data;
		if (!data) return;

		const client: WsClient = {
			send: (msg: string) => ws.send(msg),
			isOpen: () => ws.readyState === WebSocket.OPEN,
			close: () => ws.close(),
			getBufferedAmount: () => ws.bufferedAmount,
			// Bun's ServerWebSocket takes the compress flag as a second argument.
			sendUncompressed: (msg: string) => (ws as unknown as { send(data: string, compress: boolean): void }).send(msg, false)
		};

		if (data.type === 'relay' && data.base && data.target) {
			const upstream = openRelayUpstream(
				data.base,
				data.target,
				{ send: (msg) => ws.send(msg), close: (code, reason) => ws.close(code, reason) },
				MACHINE_ID
			);
			wsDataMap.set(ws, { ...data, client, upstream });
			return;
		}

		// Store client reference for proper cleanup in close handler
		wsDataMap.set(ws, { ...data, client });

		let accepted = false;
		if (data.type === 'sessions') {
			accepted = sessionsWsManager.addClient(client, { fleet: data.fleet });
		} else if (data.type === 'terminal' && data.target) {
			accepted = terminalWsManager.addClient(client, data.target);
		} else if (data.type === 'transcript' && data.target) {
			accepted = transcriptWsManager.addClient(client, data.target, data.agent);
		} else if (data.type === 'browser' && data.target) {
			accepted = browserWsManager.addClient(client, data.target);
		}

		// If not accepted (max clients reached), close the connection
		if (!accepted) {
			ws.close(1013, 'Max clients reached');
		}
	},

	message(ws: WebSocket, message: string | Buffer) {
		const data = wsDataMap.get(ws);
		if (data?.upstream) {
			data.upstream.send(message);
			return;
		}
		const msgStr = message.toString();

		const target = data?.target;
		let handlers: WsMessageHandlers | undefined;
		if (target && data?.type === 'terminal') {
			handlers = {
				resize: (cols: number, rows: number) => resizePane(target, cols, rows),
				historyRequest: (before: number, count: number) =>
					terminalWsManager.requestHistory(data.client, target, before, count)
			};
		} else if (target && data?.type === 'transcript') {
			// The transcript sends only the tail of a long session; this is the
			// reader asking for the slice above what they already have.
			handlers = {
				historyRequest: (before: number, count: number) =>
					transcriptWsManager.requestHistory(data.client, target, before, count),
				subagentRequest: (agentId: string) =>
					transcriptWsManager.requestSubagent(data.client, target, agentId)
			};
		} else if (target && data?.type === 'browser') {
			handlers = { input: (text: string) => browserWsManager.handleMessage(data.client, target, text) };
		}
		const response = handleWsMessage(msgStr, handlers);

		if (response === 'pong') {
			ws.send('pong');
		}
	},

	close(ws: WebSocket) {
		release(ws);
	},

	error(ws: WebSocket, error: Error) {
		// Handle malformed WebSocket frames (e.g., invalid close codes from mobile browsers)
		// This prevents the server from crashing when clients disconnect abruptly
		const data = wsDataMap.get(ws);
		console.log(`[ws:${data?.type ?? 'unknown'}] WebSocket error`, {
			code: (error as { code?: string }).code,
			message: error.message
		});

		release(ws);
	}
};

/** Let go of whatever a closed or failed socket held: its relayed upstream, or its manager's client. */
function release(ws: WebSocket) {
	const data = wsDataMap.get(ws);
	if (!data) return;
	if (data.upstream) {
		data.upstream.close();
	} else if (data.type === 'sessions') {
		sessionsWsManager.removeClient(data.client);
	} else if (data.type === 'terminal') {
		terminalWsManager.removeClient(data.client, data.target);
	} else if (data.type === 'transcript') {
		transcriptWsManager.removeClient(data.client, data.target);
	} else if (data.type === 'browser') {
		browserWsManager.removeClient(data.client, data.target);
	}
	wsDataMap.delete(ws);
}
