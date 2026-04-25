import { redirect, type Handle } from '@sveltejs/kit';
import {
	SessionsWsManager,
	TerminalWsManager,
	handleWsMessage,
	parseWsPath,
	resizePane,
	type WsClient
} from '$shared/server/ws-handlers.js';
import { isAuthEnabled, validateAuthToken, AUTH_COOKIE } from '$lib/server/auth.js';

// Global manager instances with config
const sessionsWsManager = new SessionsWsManager({ debug: true });
const terminalWsManager = new TerminalWsManager({ debug: true });

// Map to store WebSocket data (type, target, and client wrapper for proper cleanup)
const wsDataMap = new WeakMap<
	WebSocket,
	{ type: 'sessions' | 'terminal'; target?: string; client: WsClient }
>();

// Handle function for SvelteKit
export const handle: Handle = async ({ event, resolve }) => {
	const pathname = event.url.pathname;

	// Skip auth for login routes
	const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/api/auth');

	// Check authentication if enabled
	if (isAuthEnabled() && !isAuthRoute) {
		const token = event.cookies.get(AUTH_COOKIE.name);
		const isAuthenticated = validateAuthToken(token);

		if (!isAuthenticated) {
			// For API routes, return 401
			if (pathname.startsWith('/api/')) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			// For pages, redirect to login
			throw redirect(302, '/login');
		}
	}

	// Check for WebSocket upgrade
	const connectionHeader = event.request.headers.get('connection');
	const upgradeHeader = event.request.headers.get('upgrade');

	if (
		connectionHeader?.toLowerCase().includes('upgrade') &&
		upgradeHeader?.toLowerCase() === 'websocket'
	) {
		const url = new URL(event.request.url);
		const parsed = parseWsPath(url.pathname, url.searchParams);

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
	open(ws: WebSocket & { data?: { type: 'sessions' | 'terminal'; target?: string } }) {
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
		}

		// If not accepted (max clients reached), close the connection
		if (!accepted) {
			ws.close(1013, 'Max clients reached');
		}
	},

	message(ws: WebSocket, message: string | Buffer) {
		const msgStr = message.toString();
		const data = wsDataMap.get(ws);

		// Handle ping/pong for keep-alive
		const response = handleWsMessage(
			msgStr,
			data?.type === 'terminal' && data.target
				? (cols, rows) => resizePane(data.target!, cols, rows)
				: undefined,
			data?.type === 'terminal' && data.target
				? (lines) => terminalWsManager.setHistoryDepth(data.target!, lines)
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
			}
			wsDataMap.delete(ws);
		}
	}
};
