import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';

// Dev WebSocket plugin - uses shared handlers
function devWebSocket() {
	let wss: WebSocketServer;

	return {
		name: 'dev-websocket',

		async configureServer(server: ViteDevServer) {
			if (!server.httpServer) return;

			// Import shared handlers
			const {
				handleWsMessage,
				parseWsPath,
				resizePane
			} = await import('../src/server/ws-handlers.js');
			type WsClient = import('../src/server/ws-handlers.js').WsClient;

			// Use globalThis-backed singletons so API mutation routes and
			// this WS plugin share the same client registry.
			const { sessionsWsManager, terminalWsManager, transcriptWsManager } = await import(
				'./src/lib/server/ws-managers.js'
			);

			// Track WebSocket -> target mapping for cleanup
			const wsTargets = new WeakMap<WebSocket, string>();

			// Create WsClient wrapper for ws library
			function createClient(ws: WebSocket): WsClient {
				return {
					send: (msg: string) => ws.send(msg),
					isOpen: () => ws.readyState === WebSocket.OPEN,
					close: () => ws.close(),
					getBufferedAmount: () => ws.bufferedAmount
				};
			}

			// Create WebSocket server with compression enabled
			wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });

			// Handle WebSocketServer-level errors
			wss.on('error', (error) => {
				console.error('[wss] WebSocketServer error:', error.message);
			});

			wss.on('connection', (ws, req) => {
				const url = new URL(req.url || '', 'http://localhost');
				const parsed = parseWsPath(url.pathname);

				if (!parsed) {
					ws.close();
					return;
				}

				const client = createClient(ws);

				// Handle WebSocket errors to prevent server crashes
				ws.on('error', (error) => {
					console.error('[ws] WebSocket error:', error.message);
					// Don't rethrow - just clean up
				});

				if (parsed.type === 'sessions') {
					const accepted = sessionsWsManager.addClient(client);
					if (!accepted) {
						ws.close(1013, 'Max clients reached');
						return;
					}

					ws.on('message', (data) => {
						const response = handleWsMessage(data.toString());
						if (response === 'pong') ws.send('pong');
					});

					ws.on('close', () => sessionsWsManager.removeClient(client));
				} else if (parsed.type === 'terminal') {
					const { target } = parsed;
					const accepted = terminalWsManager.addClient(client, target);
					if (!accepted) {
						ws.close(1013, 'Max clients reached');
						return;
					}

					wsTargets.set(ws, target);

					ws.on('message', (data) => {
						const response = handleWsMessage(data.toString(), {
							resize: (cols, rows) => resizePane(target, cols, rows),
							historyRequest: (before, count) =>
								terminalWsManager.requestHistory(client, target, before, count)
						});
						if (response === 'pong') ws.send('pong');
					});

					ws.on('close', () => {
						const t = wsTargets.get(ws);
						terminalWsManager.removeClient(client, t);
					});
				} else if (parsed.type === 'transcript') {
					const { target } = parsed;
					const accepted = transcriptWsManager.addClient(client, target);
					if (!accepted) {
						ws.close(1013, 'Max clients reached');
						return;
					}

					wsTargets.set(ws, target);

					ws.on('message', (data) => {
						const response = handleWsMessage(data.toString(), {
							historyRequest: (before, count) =>
								transcriptWsManager.requestHistory(client, target, before, count)
						});
						if (response === 'pong') ws.send('pong');
					});

					ws.on('close', () => {
						const t = wsTargets.get(ws);
						transcriptWsManager.removeClient(client, t);
					});
				}
			});

			// Handle upgrade requests (skip Vite HMR)
			server.httpServer.on('upgrade', (req, socket, head) => {
				if (req.headers['sec-websocket-protocol'] === 'vite-hmr') return;
				wss.handleUpgrade(req, socket, head, (ws) => {
					// Attach error handler IMMEDIATELY before emitting 'connection'
					// This catches errors from malformed frames (e.g., mobile browser invalid close codes)
					ws.on('error', (error) => {
						console.log('[ws] WebSocket error (early):', {
							code: (error as { code?: string }).code,
							message: error.message
						});
					});
					wss.emit('connection', ws, req);
				});
			});

			server.httpServer.on('close', () => wss?.close());

			console.log('[dev] WebSocket ready at /api/sessions/stream and /api/sessions/[target]/stream');
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), devWebSocket()],
	server: {
		host: '0.0.0.0',
		allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()) ?? true
	},
	build: {
		target: 'esnext'
	}
});
