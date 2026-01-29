/**
 * Shared WebSocket handler logic for both dev (ws) and production (Bun) servers.
 * Abstracts the WebSocket-specific APIs behind a simple interface.
 *
 * Features:
 * - Max clients limit to prevent server overload
 * - Structured error logging
 * - Backpressure handling for slow clients
 */

import { execFileSync } from 'child_process';
import { getAllSessions, updateSession, type Session } from '../db/index.js';
import { checkForInterruption, getPaneTitle } from '../tmux/pane.js';
import { resizeTmuxWindow } from '../tmux/resize.js';
import { sessionWatcher } from './watcher.js';

// ============================================================================
// Configuration
// ============================================================================

export interface WsConfig {
	/** Max clients for sessions endpoint (default: 50) */
	maxSessionsClients?: number;
	/** Max clients per terminal target (default: 10) */
	maxTerminalClientsPerTarget?: number;
	/** Max total terminal clients across all targets (default: 100) */
	maxTerminalClientsTotal?: number;
	/** Max queued messages before dropping slow client (default: 100) */
	maxQueuedMessages?: number;
	/** Enable debug logging (default: false) */
	debug?: boolean;
}

const DEFAULT_CONFIG: Required<WsConfig> = {
	maxSessionsClients: 50,
	maxTerminalClientsPerTarget: 10,
	maxTerminalClientsTotal: 100,
	maxQueuedMessages: 100,
	debug: false
};

// ============================================================================
// Logging
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
	level: LogLevel;
	component: string;
	message: string;
	data?: Record<string, unknown>;
}

function log(entry: LogEntry, config: Required<WsConfig>): void {
	if (entry.level === 'debug' && !config.debug) return;

	const prefix = `[ws:${entry.component}]`;
	const msg = entry.data
		? `${prefix} ${entry.message} ${JSON.stringify(entry.data)}`
		: `${prefix} ${entry.message}`;

	switch (entry.level) {
		case 'debug':
			console.debug(msg);
			break;
		case 'info':
			console.info(msg);
			break;
		case 'warn':
			console.warn(msg);
			break;
		case 'error':
			console.error(msg);
			break;
	}
}

// ============================================================================
// Generic WebSocket client interface
// ============================================================================

export interface WsClient {
	send: (data: string) => void;
	isOpen: () => boolean;
	close: () => void;
	/** Optional: Get buffered amount for backpressure detection */
	getBufferedAmount?: () => number;
}

// ============================================================================
// Message types
// ============================================================================

export interface SessionsMessage {
	type: 'sessions' | 'connected';
	sessions: (Session & { pane_title: string | null })[];
	count: number;
	timestamp: number;
}

export interface TerminalMessage {
	type: 'output';
	output: string;
	timestamp: number;
}

export interface ResizeMessage {
	type: 'resize';
	cols: number;
	rows: number;
}

// ============================================================================
// Session Helpers
// ============================================================================

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

export function getEnrichedSessions(): (Session & { pane_title: string | null })[] {
	syncSessionStates();
	const sessions = getAllSessions();
	const enrichedSessions = sessions.map((s) => ({
		...s,
		pane_title: s.tmux_target ? getPaneTitle(s.tmux_target) : null
	}));
	return deduplicateByTmuxTarget(enrichedSessions);
}

// ============================================================================
// Terminal Helpers
// ============================================================================

export function capturePaneOutput(target: string): string | null {
	try {
		return execFileSync('tmux', ['capture-pane', '-t', target, '-p', '-S', '-100'], {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 2000
		});
	} catch {
		return null;
	}
}

export function resizePane(target: string, cols: number, rows: number): void {
	resizeTmuxWindow(target, cols, rows);
}

// ============================================================================
// Sessions WebSocket Manager
// ============================================================================

export class SessionsWsManager {
	private clients = new Set<WsClient>();
	private unsubscribe: (() => void) | null = null;
	private lastHash = '';
	private config: Required<WsConfig>;
	private droppedClients = 0;

	constructor(config?: WsConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Get current stats */
	getStats(): { clients: number; droppedClients: number } {
		return {
			clients: this.clients.size,
			droppedClients: this.droppedClients
		};
	}

	/**
	 * Add a client. Returns false if max clients reached.
	 */
	addClient(client: WsClient): boolean {
		if (this.clients.size >= this.config.maxSessionsClients) {
			log(
				{
					level: 'warn',
					component: 'sessions',
					message: 'Max clients reached, rejecting connection',
					data: { current: this.clients.size, max: this.config.maxSessionsClients }
				},
				this.config
			);
			return false;
		}

		this.clients.add(client);
		log(
			{
				level: 'debug',
				component: 'sessions',
				message: 'Client connected',
				data: { total: this.clients.size }
			},
			this.config
		);

		if (this.clients.size === 1 && !this.unsubscribe) {
			console.log('[ws:sessions] First client, subscribing to watcher');
			this.unsubscribe = sessionWatcher.subscribe(() => this.broadcastIfChanged());
		} else {
			console.log('[ws:sessions] addClient: clients=', this.clients.size, 'hasUnsubscribe=', !!this.unsubscribe);
		}
		this.sendToClient(client, this.createMessage('connected'));
		return true;
	}

	removeClient(client: WsClient): void {
		const had = this.clients.delete(client);
		if (had) {
			log(
				{
					level: 'debug',
					component: 'sessions',
					message: 'Client disconnected',
					data: { total: this.clients.size }
				},
				this.config
			);
		}

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
		console.log('[ws:sessions] broadcastIfChanged called, clients:', this.clients.size);
		const message = this.createMessage('sessions');
		const hash = JSON.stringify(message.sessions);
		if (hash === this.lastHash) {
			console.log('[ws:sessions] Hash unchanged, skipping broadcast');
			return;
		}
		console.log('[ws:sessions] Broadcasting to', this.clients.size, 'clients');
		this.lastHash = hash;
		const data = JSON.stringify(message);

		for (const client of this.clients) {
			if (!this.sendToClient(client, message, data)) {
				// Client is slow/dead, remove it
				this.clients.delete(client);
				this.droppedClients++;
				log(
					{
						level: 'warn',
						component: 'sessions',
						message: 'Dropped slow client',
						data: { total: this.clients.size }
					},
					this.config
				);
			}
		}
	}

	private sendToClient(client: WsClient, _message: SessionsMessage, data?: string): boolean {
		try {
			if (!client.isOpen()) return false;

			// Backpressure check
			if (client.getBufferedAmount) {
				const buffered = client.getBufferedAmount();
				// If buffer is building up, consider this a slow client
				if (buffered > 64 * 1024) {
					// 64KB threshold
					log(
						{
							level: 'warn',
							component: 'sessions',
							message: 'Client backpressure detected',
							data: { buffered }
						},
						this.config
					);
					return false;
				}
			}

			client.send(data ?? JSON.stringify(_message));
			return true;
		} catch (err) {
			log(
				{
					level: 'error',
					component: 'sessions',
					message: 'Failed to send to client',
					data: { error: String(err) }
				},
				this.config
			);
			return false;
		}
	}
}

// ============================================================================
// Terminal WebSocket Manager
// ============================================================================

export class TerminalWsManager {
	private clients = new Map<string, Set<WsClient>>();
	private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
	private lastOutput = new Map<string, string>();
	private config: Required<WsConfig>;
	private totalClients = 0;
	private droppedClients = 0;

	constructor(config?: WsConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Get current stats */
	getStats(): { totalClients: number; targets: number; droppedClients: number } {
		return {
			totalClients: this.totalClients,
			targets: this.clients.size,
			droppedClients: this.droppedClients
		};
	}

	/**
	 * Add a client for a target. Returns false if max clients reached.
	 */
	addClient(client: WsClient, target: string): boolean {
		// Check total limit
		if (this.totalClients >= this.config.maxTerminalClientsTotal) {
			log(
				{
					level: 'warn',
					component: 'terminal',
					message: 'Max total clients reached',
					data: { current: this.totalClients, max: this.config.maxTerminalClientsTotal }
				},
				this.config
			);
			return false;
		}

		// Check per-target limit
		const targetClients = this.clients.get(target);
		if (targetClients && targetClients.size >= this.config.maxTerminalClientsPerTarget) {
			log(
				{
					level: 'warn',
					component: 'terminal',
					message: 'Max clients per target reached',
					data: { target, current: targetClients.size, max: this.config.maxTerminalClientsPerTarget }
				},
				this.config
			);
			return false;
		}

		if (!this.clients.has(target)) {
			this.clients.set(target, new Set());
		}
		this.clients.get(target)!.add(client);
		this.totalClients++;

		log(
			{
				level: 'debug',
				component: 'terminal',
				message: 'Client connected',
				data: { target, targetClients: this.clients.get(target)!.size, total: this.totalClients }
			},
			this.config
		);

		if (this.clients.get(target)!.size === 1) {
			this.startPolling(target);
		}
		const output = capturePaneOutput(target) ?? '';
		this.sendToClient(client, { type: 'output', output, timestamp: Date.now() });
		return true;
	}

	removeClient(client: WsClient, target?: string): void {
		if (target) {
			const targetClients = this.clients.get(target);
			if (targetClients && targetClients.delete(client)) {
				this.totalClients--;
				log(
					{
						level: 'debug',
						component: 'terminal',
						message: 'Client disconnected',
						data: { target, targetClients: targetClients.size, total: this.totalClients }
					},
					this.config
				);

				if (targetClients.size === 0) {
					this.stopPolling(target);
					this.clients.delete(target);
					this.lastOutput.delete(target);
				}
			}
		} else {
			// Find and remove from any target
			for (const [t, clients] of this.clients) {
				if (clients.delete(client)) {
					this.totalClients--;
					if (clients.size === 0) {
						this.stopPolling(t);
						this.clients.delete(t);
						this.lastOutput.delete(t);
					}
					break;
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
				if (!this.sendToClient(client, message, data)) {
					// Client is slow/dead, remove it
					clients.delete(client);
					this.totalClients--;
					this.droppedClients++;
					log(
						{
							level: 'warn',
							component: 'terminal',
							message: 'Dropped slow client',
							data: { target, total: this.totalClients }
						},
						this.config
					);
				}
			}

			// Clean up if no clients left
			if (clients.size === 0) {
				this.stopPolling(target);
				this.clients.delete(target);
				this.lastOutput.delete(target);
			}
		}
	}

	private sendToClient(client: WsClient, _message: TerminalMessage, data?: string): boolean {
		try {
			if (!client.isOpen()) return false;

			// Backpressure check
			if (client.getBufferedAmount) {
				const buffered = client.getBufferedAmount();
				if (buffered > 64 * 1024) {
					log(
						{
							level: 'warn',
							component: 'terminal',
							message: 'Client backpressure detected',
							data: { buffered }
						},
						this.config
					);
					return false;
				}
			}

			client.send(data ?? JSON.stringify(_message));
			return true;
		} catch (err) {
			log(
				{
					level: 'error',
					component: 'terminal',
					message: 'Failed to send to client',
					data: { error: String(err) }
				},
				this.config
			);
			return false;
		}
	}
}

// ============================================================================
// Message Handling
// ============================================================================

/**
 * Handle incoming WebSocket message. Returns 'pong' if ping, otherwise parses resize.
 */
export function handleWsMessage(
	msgStr: string,
	onResize?: (cols: number, rows: number) => void
): 'pong' | null {
	if (msgStr === 'ping') {
		return 'pong';
	}

	if (onResize) {
		try {
			const msg = JSON.parse(msgStr) as ResizeMessage;
			if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
				onResize(msg.cols, msg.rows);
			}
		} catch {
			// Ignore malformed messages
		}
	}

	return null;
}

// ============================================================================
// URL Parsing
// ============================================================================

export function parseWsPath(
	pathname: string
): { type: 'sessions' } | { type: 'terminal'; target: string } | null {
	if (pathname === '/api/sessions/stream') {
		return { type: 'sessions' };
	}

	const termMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
	if (termMatch) {
		return { type: 'terminal', target: decodeURIComponent(termMatch[1]) };
	}

	return null;
}
