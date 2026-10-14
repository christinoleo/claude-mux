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
			const { FORWARDED_HEADER, isPeerLink } = await import('../src/server/fleet-relay.js');

			// Use globalThis-backed singletons so API mutation routes and
			// this WS plugin share the same client registry.
			const { browserWsManager, sessionsWsManager, terminalWsManager, transcriptWsManager } = await import(
				'./src/lib/server/ws-managers.js'
			);
			const { pageOriginAllowed } = await import('../src/server/page-origin.js');

			// Track WebSocket -> target mapping for cleanup
			const wsTargets = new WeakMap<WebSocket, string>();

			// Create WsClient wrapper for ws library
			function createClient(ws: WebSocket): WsClient {
				return {
					send: (msg: string) => ws.send(msg),
					isOpen: () => ws.readyState === WebSocket.OPEN,
					close: () => ws.close(),
					getBufferedAmount: () => ws.bufferedAmount,
					sendUncompressed: (msg: string) => ws.send(msg, { compress: false })
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
				const parsed = parseWsPath(url.pathname, url.search);

				if (!parsed) {
					ws.close();
					return;
				}

				// A WebSocket is not held to CORS: only this server's own page may open one.
				if (!pageOriginAllowed(req.headers.origin, req.headers.host)) {
					ws.close(1008, 'Forbidden');
					return;
				}

				const client = createClient(ws);

				// Handle WebSocket errors to prevent server crashes
				ws.on('error', (error) => {
					console.error('[ws] WebSocket error:', error.message);
					// Don't rethrow - just clean up
				});

				if (parsed.type === 'sessions') {
					const forwarded = req.headers[FORWARDED_HEADER];
					const peer = isPeerLink(req.headers.origin, typeof forwarded === 'string' ? forwarded : null);
					const accepted = sessionsWsManager.addClient(client, { fleet: parsed.fleet, peer });
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
					const accepted = transcriptWsManager.addClient(client, target, parsed.agent);
					if (!accepted) {
						ws.close(1013, 'Max clients reached');
						return;
					}

					wsTargets.set(ws, target);

					ws.on('message', (data) => {
						const response = handleWsMessage(data.toString(), {
							historyRequest: (before, count) =>
								transcriptWsManager.requestHistory(client, target, before, count),
							subagentRequest: (agentId) =>
								transcriptWsManager.requestSubagent(client, target, agentId)
						});
						if (response === 'pong') ws.send('pong');
					});

					ws.on('close', () => {
						const t = wsTargets.get(ws);
						transcriptWsManager.removeClient(client, t);
					});
				} else if (parsed.type === 'browser') {
					const { target } = parsed;
					if (!browserWsManager.addClient(client, target)) {
						ws.close(1013, 'Max clients reached');
						return;
					}

					ws.on('message', (data) => {
						const response = handleWsMessage(data.toString(), {
							input: (text) => browserWsManager.handleMessage(client, target, text)
						});
						if (response === 'pong') ws.send('pong');
					});

					ws.on('close', () => browserWsManager.removeClient(client, target));
				}
			});

			// Discovery and the fleet relay need this server's own port.
			server.httpServer.once('listening', () => {
				const address = server.httpServer?.address();
				if (address && typeof address === 'object') process.env.CLAUDE_MUX_PORT = String(address.port);
			});

			const { admitRelay, openRelayUpstream, parseFleetPath } = await import('../src/server/fleet-relay.js');
			const { STATUS_CODES } = await import('node:http');

			/** A page's socket to another machine, joined to that machine's (see hooks.server.ts). */
			async function relayUpgrade(
				req: import('node:http').IncomingMessage,
				socket: import('node:stream').Duplex,
				head: Buffer,
				fleet: { machine: string; path: string },
				search: string
			) {
				// Loaded through Vite rather than imported: these are app modules,
				// written against the app's aliases.
				const [{ machineUrl }, { MACHINE_ID }, { relayGate }] = await Promise.all([
					server.ssrLoadModule('/src/lib/server/discover.ts'),
					server.ssrLoadModule('/src/lib/server/instance.ts'),
					server.ssrLoadModule('/src/lib/server/fleet.ts')
				]);
				const base = await admitRelay(req.headers.origin, req.headers.host, fleet, machineUrl, relayGate);
				if (typeof base !== 'string') {
					socket.write(
						`HTTP/1.1 ${base.status} ${STATUS_CODES[base.status]}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${await base.text()}`
					);
					socket.destroy();
					return;
				}
				wss.handleUpgrade(req, socket, head, (ws) => {
					ws.on('error', (error) => console.log('[ws:relay] WebSocket error:', error.message));
					const upstream = openRelayUpstream(
						base,
						`${fleet.path}${search}`,
						{ send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
						MACHINE_ID as string
					);
					ws.on('message', (data, isBinary) => upstream.send(isBinary ? (data as Buffer) : data.toString()));
					ws.on('close', () => upstream.close());
				});
			}

			// Handle upgrade requests (skip Vite HMR)
			server.httpServer.on('upgrade', (req, socket, head) => {
				if (req.headers['sec-websocket-protocol'] === 'vite-hmr') return;
				const url = new URL(req.url || '', 'http://localhost');
				const fleet = parseFleetPath(url.pathname);
				if (fleet) {
					relayUpgrade(req, socket, head, fleet, url.search).catch((error) => {
						console.log('[ws:relay] upgrade failed:', error instanceof Error ? error.message : error);
						socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
						socket.destroy();
					});
					return;
				}
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
		allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()) ?? true,
		// As in production, /api/ answers its own page only (ADR 0004); Vite would otherwise allow loopback origins.
		cors: false
	},
	build: {
		target: 'esnext',
		// Readable stacks in the client error log; the tool is private.
		sourcemap: true
	}
});
