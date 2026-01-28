import type { Handle } from '@sveltejs/kit';
import { execFileSync } from 'child_process';
import { getAllSessions, updateSession } from '$shared/db/index.js';
import { checkForInterruption, getPaneTitle } from '$shared/tmux/pane.js';
import { resizeTmuxWindow } from '$shared/tmux/resize.js';
import type { Session } from '$shared/db/index.js';
import { sessionWatcher } from '$shared/server/watcher.js';

// WebSocket client interface
interface WebSocketClient {
	send: (data: string) => void;
	close: () => void;
}

// Message types
interface SessionsMessage {
	type: 'sessions' | 'connected';
	sessions: (Session & { pane_title: string | null })[];
	count: number;
	timestamp: number;
}

interface TerminalMessage {
	type: 'output';
	output: string;
	timestamp: number;
}

interface ResizeMessage {
	type: 'resize';
	cols: number;
	rows: number;
}

// Sync session state by detecting interruptions
function syncSessionStates(): void {
	const sessions = getAllSessions().filter((s) => s.tmux_target);
	for (const session of sessions) {
		if (!session.tmux_target) continue;
		const update = checkForInterruption(session.tmux_target);
		if (update && session.state !== 'idle') {
			updateSession(session.id, update);
		}
	}
}

// Deduplicate sessions by tmux_target
function deduplicateByTmuxTarget<T extends { tmux_target: string | null; last_update: number }>(
	sessions: T[]
): T[] {
	const byTarget = new Map<string, T>();
	const noTarget: T[] = [];
	for (const session of sessions) {
		if (!session.tmux_target) {
			noTarget.push(session);
			continue;
		}
		const existing = byTarget.get(session.tmux_target);
		if (!existing || session.last_update > existing.last_update) {
			byTarget.set(session.tmux_target, session);
		}
	}
	return [...byTarget.values(), ...noTarget];
}

// Get enriched sessions with pane titles
function getEnrichedSessions(): (Session & { pane_title: string | null })[] {
	syncSessionStates();
	const sessions = getAllSessions();
	const enrichedSessions = sessions.map((s) => ({
		...s,
		pane_title: s.tmux_target ? getPaneTitle(s.tmux_target) : null
	}));
	return deduplicateByTmuxTarget(enrichedSessions);
}

// Capture tmux pane output
function capturePaneOutput(target: string): string | null {
	try {
		const result = execFileSync('tmux', ['capture-pane', '-t', target, '-p', '-S', '-100'], {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 2000
		});
		return result;
	} catch {
		return null;
	}
}

// Sessions WebSocket manager
class SessionsWebSocketManager {
	private clients = new Set<WebSocketClient>();
	private unsubscribe: (() => void) | null = null;
	private lastHash = '';

	addClient(client: WebSocketClient): void {
		this.clients.add(client);
		if (this.clients.size === 1 && !this.unsubscribe) {
			this.unsubscribe = sessionWatcher.subscribe(() => {
				this.broadcastIfChanged();
			});
		}
		this.sendToClient(client, this.createMessage('connected'));
	}

	removeClient(client: WebSocketClient): void {
		this.clients.delete(client);
		if (this.clients.size === 0 && this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
			this.lastHash = '';
		}
	}

	private createMessage(type: 'sessions' | 'connected'): SessionsMessage {
		const sessions = getEnrichedSessions();
		return { type, sessions, count: sessions.length, timestamp: Date.now() };
	}

	private broadcastIfChanged(): void {
		const message = this.createMessage('sessions');
		const hash = JSON.stringify(message.sessions);
		if (hash === this.lastHash) return;
		this.lastHash = hash;
		const data = JSON.stringify(message);
		for (const client of this.clients) {
			this.sendToClient(client, message, data);
		}
	}

	private sendToClient(client: WebSocketClient, message: SessionsMessage, data?: string): void {
		try {
			client.send(data ?? JSON.stringify(message));
		} catch {
			this.removeClient(client);
		}
	}
}

// Terminal WebSocket manager
class TerminalWebSocketManager {
	private clients = new Map<string, Set<WebSocketClient>>();
	private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
	private lastOutput = new Map<string, string>();

	addClient(client: WebSocketClient, target: string): void {
		if (!this.clients.has(target)) {
			this.clients.set(target, new Set());
		}
		this.clients.get(target)!.add(client);
		if (this.clients.get(target)!.size === 1) {
			this.startPolling(target);
		}
		const output = capturePaneOutput(target) ?? '';
		this.sendToClient(client, { type: 'output', output, timestamp: Date.now() });
	}

	removeClient(client: WebSocketClient, target?: string): void {
		if (target) {
			const targetClients = this.clients.get(target);
			if (targetClients) {
				targetClients.delete(client);
				if (targetClients.size === 0) {
					this.stopPolling(target);
					this.clients.delete(target);
					this.lastOutput.delete(target);
				}
			}
		} else {
			for (const [t, clients] of this.clients) {
				if (clients.has(client)) {
					clients.delete(client);
					if (clients.size === 0) {
						this.stopPolling(t);
						this.clients.delete(t);
						this.lastOutput.delete(t);
					}
				}
			}
		}
	}

	private startPolling(target: string): void {
		if (this.pollTimers.has(target)) return;
		const timer = setInterval(() => this.pollAndBroadcast(target), 200);
		this.pollTimers.set(target, timer);
	}

	private stopPolling(target: string): void {
		const timer = this.pollTimers.get(target);
		if (timer) {
			clearInterval(timer);
			this.pollTimers.delete(target);
		}
	}

	private pollAndBroadcast(target: string): void {
		const output = capturePaneOutput(target) ?? '';
		const lastOutput = this.lastOutput.get(target) ?? '';
		if (output === lastOutput) return;
		this.lastOutput.set(target, output);
		const message: TerminalMessage = { type: 'output', output, timestamp: Date.now() };
		const data = JSON.stringify(message);
		const clients = this.clients.get(target);
		if (clients) {
			for (const client of clients) {
				this.sendToClient(client, message, data);
			}
		}
	}

	private sendToClient(client: WebSocketClient, message: TerminalMessage, data?: string): void {
		try {
			client.send(data ?? JSON.stringify(message));
		} catch {
			this.removeClient(client);
		}
	}

	resizePane(target: string, cols: number, rows: number): void {
		resizeTmuxWindow(target, cols, rows);
	}
}

// Global manager instances
const sessionsWsManager = new SessionsWebSocketManager();
const terminalWsManager = new TerminalWebSocketManager();

// Map to store WebSocket data (type, target, and client wrapper for proper cleanup)
const wsDataMap = new WeakMap<
	WebSocket,
	{ type: 'sessions' | 'terminal'; target?: string; client: WebSocketClient }
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

		// Sessions stream
		if (url.pathname === '/api/sessions/stream') {
			// @ts-expect-error - platform is provided by svelte-adapter-bun
			await event.platform.server.upgrade(event.platform.request, {
				data: { type: 'sessions' }
			});
			return new Response(null, { status: 101 });
		}

		// Terminal stream
		const termMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
		if (termMatch) {
			const target = decodeURIComponent(termMatch[1]);
			// @ts-expect-error - platform is provided by svelte-adapter-bun
			await event.platform.server.upgrade(event.platform.request, {
				data: { type: 'terminal', target }
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

		const client: WebSocketClient = {
			send: (msg: string) => ws.send(msg),
			close: () => ws.close()
		};

		// Store client reference for proper cleanup in close handler
		wsDataMap.set(ws, { ...data, client });

		if (data.type === 'sessions') {
			sessionsWsManager.addClient(client);
		} else if (data.type === 'terminal' && data.target) {
			terminalWsManager.addClient(client, data.target);
		}
	},

	message(ws: WebSocket, message: string | Buffer) {
		const data = wsDataMap.get(ws);
		if (!data || data.type !== 'terminal' || !data.target) return;

		try {
			const msg = JSON.parse(message.toString()) as ResizeMessage;
			if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
				terminalWsManager.resizePane(data.target, msg.cols, msg.rows);
			}
		} catch {
			// Ignore malformed messages
		}
	},

	close(ws: WebSocket) {
		const data = wsDataMap.get(ws);
		if (!data) return;

		// Use the same client reference that was stored in open()
		if (data.type === 'sessions') {
			sessionsWsManager.removeClient(data.client);
		} else if (data.type === 'terminal') {
			terminalWsManager.removeClient(data.client, data.target);
		}

		wsDataMap.delete(ws);
	}
};
