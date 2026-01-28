import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import { execSync } from 'child_process';

// Dev WebSocket plugin - based on @ubermanu/sveltekit-websocket pattern
function devWebSocket() {
	let wss: WebSocketServer;

	// Sessions stream state
	const sessionsClients = new Set<WebSocket>();
	let lastHash = '';
	let unsubscribe: (() => void) | null = null;

	// Terminal stream state
	const terminalClients = new Map<string, Set<WebSocket>>();
	const terminalTimers = new Map<string, ReturnType<typeof setInterval>>();
	const terminalLastOutput = new Map<string, string>();

	return {
		name: 'dev-websocket',

		async configureServer(server: ViteDevServer) {
			if (!server.httpServer) return;

			// Import server modules
			const { sessionWatcher } = await import('../src/server/watcher.js');
			const { getAllSessions, updateSession } = await import('../src/db/index.js');
			const { checkForInterruption, getPaneTitle } = await import('../src/tmux/pane.js');

			// Session helpers
			function getEnrichedSessions() {
				// Sync states first
				for (const s of getAllSessions().filter((s) => s.tmux_target)) {
					if (!s.tmux_target) continue;
					const update = checkForInterruption(s.tmux_target);
					if (update && s.state !== 'idle') updateSession(s.id, update);
				}

				// Deduplicate by tmux_target
				const sessions = getAllSessions();
				const byTarget = new Map<string, (typeof sessions)[0]>();
				const noTarget: typeof sessions = [];

				for (const s of sessions) {
					if (!s.tmux_target) {
						noTarget.push(s);
						continue;
					}
					const existing = byTarget.get(s.tmux_target);
					if (!existing || s.last_update > existing.last_update) {
						byTarget.set(s.tmux_target, s);
					}
				}

				return [...byTarget.values(), ...noTarget].map((s) => ({
					...s,
					pane_title: s.tmux_target ? getPaneTitle(s.tmux_target) : null
				}));
			}

			function broadcastSessions() {
				const sessions = getEnrichedSessions();
				const hash = JSON.stringify(sessions);
				if (hash === lastHash) return;
				lastHash = hash;

				const msg = JSON.stringify({
					type: 'sessions',
					sessions,
					count: sessions.length,
					timestamp: Date.now()
				});

				for (const ws of sessionsClients) {
					if (ws.readyState === WebSocket.OPEN) ws.send(msg);
				}
			}

			// Terminal helpers
			function capturePaneOutput(target: string): string | null {
				try {
					return execSync(`tmux capture-pane -t "${target}" -p -S -100`, {
						encoding: 'utf-8',
						stdio: ['pipe', 'pipe', 'pipe'],
						timeout: 2000
					});
				} catch {
					return null;
				}
			}

			function startTerminalPolling(target: string) {
				if (terminalTimers.has(target)) return;
				const timer = setInterval(() => {
					const output = capturePaneOutput(target) ?? '';
					const last = terminalLastOutput.get(target) ?? '';
					if (output === last) return;
					terminalLastOutput.set(target, output);

					const msg = JSON.stringify({ type: 'output', output, timestamp: Date.now() });
					const clients = terminalClients.get(target);
					if (clients) {
						for (const ws of clients) {
							if (ws.readyState === WebSocket.OPEN) ws.send(msg);
						}
					}
				}, 200);
				terminalTimers.set(target, timer);
			}

			function stopTerminalPolling(target: string) {
				const timer = terminalTimers.get(target);
				if (timer) {
					clearInterval(timer);
					terminalTimers.delete(target);
					terminalLastOutput.delete(target);
				}
			}

			function resizePane(target: string, cols: number, rows: number) {
				try {
					const safeCols = Math.max(20, Math.min(500, Math.floor(cols)));
					const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
					// Extract window target (session:window) from full target (session:window.pane)
					const windowTarget = target.replace(/\.\d+$/, '');
					execSync(`tmux resize-window -t "${windowTarget}" -x ${safeCols} -y ${safeRows}`, {
						stdio: ['pipe', 'pipe', 'pipe'],
						timeout: 2000
					});
				} catch {
					// Pane may not exist or tmux error - ignore
				}
			}

			// Create WebSocket server with compression enabled
			wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });

			wss.on('connection', (ws, req) => {
				const url = new URL(req.url || '', 'http://localhost');

				// Sessions stream: /api/sessions/stream
				if (url.pathname === '/api/sessions/stream') {
					sessionsClients.add(ws);

					// Start watcher on first client
					if (sessionsClients.size === 1 && !unsubscribe) {
						unsubscribe = sessionWatcher.subscribe(() => broadcastSessions());
					}

					// Send initial data
					const sessions = getEnrichedSessions();
					ws.send(
						JSON.stringify({
							type: 'connected',
							sessions,
							count: sessions.length,
							timestamp: Date.now()
						})
					);

					ws.on('close', () => {
						sessionsClients.delete(ws);
						if (sessionsClients.size === 0 && unsubscribe) {
							unsubscribe();
							unsubscribe = null;
							lastHash = '';
						}
					});
					return;
				}

				// Terminal stream: /api/sessions/[target]/stream
				const termMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
				if (termMatch) {
					const target = decodeURIComponent(termMatch[1]);

					if (!terminalClients.has(target)) {
						terminalClients.set(target, new Set());
					}
					terminalClients.get(target)!.add(ws);

					// Start polling on first client for this target
					if (terminalClients.get(target)!.size === 1) {
						startTerminalPolling(target);
					}

					// Send initial output
					const output = capturePaneOutput(target) ?? '';
					ws.send(JSON.stringify({ type: 'output', output, timestamp: Date.now() }));

					// Handle resize messages
					ws.on('message', (data) => {
						try {
							const msg = JSON.parse(data.toString());
							if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
								resizePane(target, msg.cols, msg.rows);
							}
						} catch {
							// Ignore malformed messages
						}
					});

					ws.on('close', () => {
						const clients = terminalClients.get(target);
						if (clients) {
							clients.delete(ws);
							if (clients.size === 0) {
								stopTerminalPolling(target);
								terminalClients.delete(target);
							}
						}
					});
					return;
				}

				// Unknown path
				ws.close();
			});

			// Handle upgrade requests (skip Vite HMR)
			server.httpServer.on('upgrade', (req, socket, head) => {
				if (req.headers['sec-websocket-protocol'] === 'vite-hmr') return;
				wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
			});

			server.httpServer.on('close', () => wss?.close());

			console.log('[dev] WebSocket ready at /api/sessions/stream and /api/sessions/[target]/stream');
		}
	};
}

export default defineConfig({
	plugins: [sveltekit(), devWebSocket()],
	server: {
		host: '0.0.0.0'
	},
	build: {
		target: 'esnext'
	}
});
