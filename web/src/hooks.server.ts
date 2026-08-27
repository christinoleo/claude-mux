import { type Handle } from '@sveltejs/kit';
import {
	handleWsMessage,
	parseWsPath,
	resizePane,
	type WsClient
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

// WebSocket handlers for svelte-adapter-bun
export const websocket = {
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

		const target = data?.type === 'terminal' ? data.target : undefined;
		const response = handleWsMessage(
			msgStr,
			target
				? {
						resize: (cols, rows) => resizePane(target, cols, rows),
						historyRequest: (before, count) =>
							terminalWsManager.requestHistory(data!.client, target, before, count)
					}
				: undefined
		);

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
