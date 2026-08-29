import { type Handle } from '@sveltejs/kit';
import {
	handleWsMessage,
	parseWsPath,
	resizePane,
	type WsClient,
	type WsMessageHandlers
} from '$shared/server/ws-handlers.js';
import { sessionsWsManager, terminalWsManager, transcriptWsManager } from '$lib/server/ws-managers.js';

// Map to store WebSocket data (type, target, and client wrapper for proper cleanup)
const wsDataMap = new WeakMap<
	WebSocket,
	{ type: 'sessions' | 'terminal' | 'transcript'; target?: string; client: WsClient }
>();

// Handle function for SvelteKit
export const handle: Handle = async ({ event, resolve }) => {
	// Check for WebSocket upgrade
	const connectionHeader = event.request.headers.get('connection');
	const upgradeHeader = event.request.headers.get('upgrade');

	if (
		connectionHeader?.toLowerCase().includes('upgrade') &&
		upgradeHeader?.toLowerCase() === 'websocket'
	) {
		const url = new URL(event.request.url);
		const parsed = parseWsPath(url.pathname);

		if (parsed) {
			// @ts-expect-error - platform is provided by svelte-adapter-bun
			await event.platform.server.upgrade(event.platform.request, {
				data: parsed
			});
			return new Response(null, { status: 101 });
		}
	}

	return resolve(event);
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
	open(ws: WebSocket & { data?: { type: 'sessions' | 'terminal' | 'transcript'; target?: string } }) {
		const data = ws.data;
		if (!data) return;

		const client: WsClient = {
			send: (msg: string) => ws.send(msg),
			isOpen: () => ws.readyState === WebSocket.OPEN,
			close: () => ws.close(),
			getBufferedAmount: () => ws.bufferedAmount
		};

		// Store client reference for proper cleanup in close handler
		wsDataMap.set(ws, { ...data, client });

		let accepted = false;
		if (data.type === 'sessions') {
			accepted = sessionsWsManager.addClient(client);
		} else if (data.type === 'terminal' && data.target) {
			accepted = terminalWsManager.addClient(client, data.target);
		} else if (data.type === 'transcript' && data.target) {
			accepted = transcriptWsManager.addClient(client, data.target);
		}

		// If not accepted (max clients reached), close the connection
		if (!accepted) {
			ws.close(1013, 'Max clients reached');
		}
	},

	message(ws: WebSocket, message: string | Buffer) {
		const msgStr = message.toString();
		const data = wsDataMap.get(ws);

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
					transcriptWsManager.requestHistory(data.client, target, before, count)
			};
		}
		const response = handleWsMessage(msgStr, handlers);

		if (response === 'pong') {
			ws.send('pong');
		}
	},

	close(ws: WebSocket) {
		const data = wsDataMap.get(ws);
		if (!data) return;

		if (data.type === 'sessions') {
			sessionsWsManager.removeClient(data.client);
		} else if (data.type === 'terminal') {
			terminalWsManager.removeClient(data.client, data.target);
		} else if (data.type === 'transcript') {
			transcriptWsManager.removeClient(data.client, data.target);
		}

		wsDataMap.delete(ws);
	},

	error(ws: WebSocket, error: Error) {
		// Handle malformed WebSocket frames (e.g., invalid close codes from mobile browsers)
		// This prevents the server from crashing when clients disconnect abruptly
		const data = wsDataMap.get(ws);
		console.log(`[ws:${data?.type ?? 'unknown'}] WebSocket error`, {
			code: (error as { code?: string }).code,
			message: error.message
		});

		// Clean up the connection
		if (data) {
			if (data.type === 'sessions') {
				sessionsWsManager.removeClient(data.client);
			} else if (data.type === 'terminal') {
				terminalWsManager.removeClient(data.client, data.target);
			} else if (data.type === 'transcript') {
				transcriptWsManager.removeClient(data.client, data.target);
			}
			wsDataMap.delete(ws);
		}
	}
};
