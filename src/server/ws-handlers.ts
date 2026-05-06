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
import { readFileSync } from 'fs';
import { getAllSessions, updateSession, readLinks, cleanupStaleSessions, type Session } from '../db/index.js';
import { getAllPaneTitles, detectRemoteControlUrl, capturePaneContentAsync, isPaneShowingSpinner, detectRecentInterruption } from '../tmux/pane.js';
import { resizeTmuxWindow } from '../tmux/resize.js';
import { sessionWatcher } from './watcher.js';
import { drainQueues, getQueueCounts } from './message-queue.js';
import type { SessionsWsMessage, SystemStatsMessage } from '../types/ws-messages.js';

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
// Message types (sessions WS uses shared schemas from types/ws-messages.ts)
// ============================================================================

export type { SessionsWsMessage, SystemStatsMessage } from '../types/ws-messages.js';

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

interface SetHistoryMessage {
	type: 'set_history';
	lines: number;
}

const DEFAULT_HISTORY_DEPTH = 150;
const MAX_HISTORY_DEPTH = 5000;

// ============================================================================
// Session Helpers
// ============================================================================


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

/**
 * Capture each target's pane once per refresh and run all content-derived
 * checks (interruption, spinner, RC URL) off that single capture instead of
 * re-spawning `tmux capture-pane` three times per session per tick.
 */
async function captureAndSyncSessions(): Promise<Map<string, string>> {
	const sessions = getAllSessions().filter((s) => s.tmux_target);
	const captures = new Map<string, string>();
	await Promise.all(
		sessions.map(async (session) => {
			if (!session.tmux_target) return;
			const content = await capturePaneContentAsync(session.tmux_target);
			if (!content) return;
			captures.set(session.tmux_target, content);

			if (session.state !== 'idle' && detectRecentInterruption(content)) {
				updateSession(session.id, {
					state: 'idle',
					current_action: null,
					prompt_text: null
				});
			}
			// If hook says idle but pane shows a spinner (e.g. compaction), override to busy
			if (session.state === 'idle' && isPaneShowingSpinner(content)) {
				updateSession(session.id, { state: 'busy', current_action: 'Compacting...' });
			}
		})
	);
	return captures;
}

/**
 * Async version of getEnrichedSessions. Uses batched tmux calls
 * and concurrent interruption checks to avoid blocking the event loop.
 */
export async function getEnrichedSessionsAsync(): Promise<(Session & { pane_title: string | null; pane_alive: boolean })[]> {
	const [captures, paneTitles] = await Promise.all([
		captureAndSyncSessions(),
		getAllPaneTitles()
	]);

	const sessions = getAllSessions();
	const links = readLinks();

	// Scan for Remote Control URLs in pane content (detect new URLs and clear stale ones)
	for (const s of sessions) {
		if (!s.tmux_target) continue;
		const content = captures.get(s.tmux_target);
		if (!content) continue;
		const rcUrl = detectRemoteControlUrl(content);
		if (rcUrl && rcUrl !== s.rc_url) {
			updateSession(s.id, { rc_url: rcUrl });
			s.rc_url = rcUrl;
		} else if (!rcUrl && s.rc_url) {
			updateSession(s.id, { rc_url: null });
			s.rc_url = null;
		}
	}

	const enrichedSessions = sessions.map((s) => {
		const paneTitle = s.tmux_target ? (paneTitles.get(s.tmux_target) ?? null) : null;
		const enriched: Session & { pane_title: string | null; pane_alive: boolean } = {
			...s,
			pane_title: paneTitle,
			pane_alive: s.tmux_target ? paneTitles.has(s.tmux_target) : true,
		};

		if (s.tmux_target && links[s.tmux_target]) {
			const mainTarget = links[s.tmux_target];
			const mainSession = sessions.find((m) => m.tmux_target === mainTarget);
			if (mainSession) {
				enriched.linked_to = mainSession.id;
			}
		}

		return enriched;
	});

	return deduplicateByTmuxTarget(enrichedSessions);
}

// ============================================================================
// Terminal Helpers
// ============================================================================

export function capturePaneOutput(target: string, depth: number = DEFAULT_HISTORY_DEPTH): string | null {
	try {
		const lines = Math.max(1, Math.min(MAX_HISTORY_DEPTH, Math.floor(depth)));
		return execFileSync('tmux', ['capture-pane', '-t', target, '-p', '-e', '-S', `-${lines}`], {
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
// System Stats (CPU/RAM/Swap from /proc, cached every 10s)
// ============================================================================

let cachedSystemStats = { cpu: 0, ram: 0, swap: 0, ramTotal: 0, swapTotal: 0 };
let prevCpuIdle = 0;
let prevCpuTotal = 0;
let systemStatsTimer: ReturnType<typeof setInterval> | null = null;
let systemStatsRefCount = 0;

function refreshSystemStats(): void {
	try {
		const stat = readFileSync('/proc/stat', 'utf-8');
		const meminfo = readFileSync('/proc/meminfo', 'utf-8');

		// CPU
		const cpuLine = stat.split('\n')[0];
		const cpuParts = cpuLine.split(/\s+/).slice(1).map(Number);
		const idle = cpuParts[3] + (cpuParts[4] || 0);
		const total = cpuParts.reduce((a, b) => a + b, 0);
		const diffIdle = idle - prevCpuIdle;
		const diffTotal = total - prevCpuTotal;
		const cpuPercent = diffTotal > 0 ? Math.round((1 - diffIdle / diffTotal) * 100) : 0;
		prevCpuIdle = idle;
		prevCpuTotal = total;

		// Memory
		const mem: Record<string, number> = {};
		for (const line of meminfo.split('\n')) {
			const match = line.match(/^(\w+):\s+(\d+)/);
			if (match) mem[match[1]] = parseInt(match[2], 10);
		}
		const memTotal = mem['MemTotal'] || 1;
		const memAvailable = mem['MemAvailable'] || 0;
		const swapTotal = mem['SwapTotal'] || 0;
		const swapFree = mem['SwapFree'] || 0;

		cachedSystemStats = {
			cpu: cpuPercent,
			ram: Math.round(((memTotal - memAvailable) / memTotal) * 100),
			swap: swapTotal > 0 ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : 0,
			ramTotal: Math.round(memTotal / 1024),
			swapTotal: Math.round(swapTotal / 1024)
		};
	} catch {
		// /proc not available (non-Linux), keep last values
	}
}

function startSystemStats(): void {
	systemStatsRefCount++;
	if (systemStatsRefCount === 1) {
		refreshSystemStats(); // initial read
		systemStatsTimer = setInterval(refreshSystemStats, 10_000);
	}
}

function stopSystemStats(): void {
	systemStatsRefCount--;
	if (systemStatsRefCount <= 0) {
		systemStatsRefCount = 0;
		if (systemStatsTimer) {
			clearInterval(systemStatsTimer);
			systemStatsTimer = null;
		}
	}
}

// ============================================================================
// Sessions WebSocket Manager
// ============================================================================

export class SessionsWsManager {
	private clients = new Set<WsClient>();
	private unsubscribe: (() => void) | null = null;
	private interruptCheckTimer: ReturnType<typeof setInterval> | null = null;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private systemStatsTimer: ReturnType<typeof setInterval> | null = null;
	private lastHash = '';
	private lastStatsHash = '';
	private config: Required<WsConfig>;
	private droppedClients = 0;
	private refreshing = false;
	private refreshQueued = false;

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
			this.unsubscribe = sessionWatcher.subscribe(() => this.refreshAndBroadcast());
			// Start interrupt check timer - runs independently of file changes
			// to catch interruptions triggered by web UI (Escape key).
			// Uses async getEnrichedSessionsAsync to avoid blocking the event loop.
			this.interruptCheckTimer = setInterval(() => {
				this.refreshAndBroadcast();
			}, 500);
			// Cleanup stale sessions (dead PIDs) periodically
			try { cleanupStaleSessions(); } catch {}
			this.cleanupTimer = setInterval(() => {
				try { cleanupStaleSessions(); } catch {}
			}, 10_000);
			// Start system stats: refresh every 10s, broadcast separately
			startSystemStats();
			this.systemStatsTimer = setInterval(() => {
				this.broadcastSystemStats();
			}, 10_000);
		} else {
			console.log('[ws:sessions] addClient: clients=', this.clients.size, 'hasUnsubscribe=', !!this.unsubscribe);
		}
		// Send initial state asynchronously (batched tmux call is more reliable for pane_alive)
		this.createSessionsMessageAsync('connected').then((msg) => {
			if (client.isOpen()) {
				this.sendToClient(client, msg);
				this.sendToClient(client, this.createSystemStatsMessage());
			}
		});
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
			// Stop interrupt check timer
			if (this.interruptCheckTimer) {
				clearInterval(this.interruptCheckTimer);
				this.interruptCheckTimer = null;
			}
			// Stop cleanup timer
			if (this.cleanupTimer) {
				clearInterval(this.cleanupTimer);
				this.cleanupTimer = null;
			}
			// Stop system stats broadcast + polling
			if (this.systemStatsTimer) {
				clearInterval(this.systemStatsTimer);
				this.systemStatsTimer = null;
			}
			stopSystemStats();
		}
	}

	/** Merge queue_count into each session object */
	private mergeQueueCounts(sessions: Session[]): void {
		const queueCounts = getQueueCounts();
		for (const session of sessions) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(session as any).queue_count =
				(session.tmux_target ? queueCounts.get(session.tmux_target) : undefined) ?? 0;
		}
	}

	private async createSessionsMessageAsync(type: 'sessions' | 'connected') {
		const sessions = await getEnrichedSessionsAsync();
		return { type, sessions, count: sessions.length, timestamp: Date.now() };
	}

	private createSystemStatsMessage(): SystemStatsMessage {
		return { type: 'systemStats' as const, ...cachedSystemStats, timestamp: Date.now() };
	}

	private refreshAndBroadcast(): void {
		// If already refreshing, queue a follow-up refresh so we don't lose
		// watcher notifications that arrive while async tmux calls are in-flight.
		if (this.refreshing) {
			this.refreshQueued = true;
			return;
		}
		this.refreshing = true;

		this.createSessionsMessageAsync('sessions')
			.then((message) => {
				// Drain queued messages for sessions that just went idle
				drainQueues(message.sessions);

				// Merge queue counts into session data for broadcast
				this.mergeQueueCounts(message.sessions);

				const hash = JSON.stringify(message.sessions);
				if (hash === this.lastHash) {
					return;
				}
				this.lastHash = hash;
				const data = JSON.stringify(message);

				for (const client of this.clients) {
					if (!this.sendToClient(client, message, data)) {
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
			})
			.catch((err) => {
				log(
					{
						level: 'error',
						component: 'sessions',
						message: 'Refresh failed',
						data: { error: String(err) }
					},
					this.config
				);
			})
			.finally(() => {
				this.refreshing = false;
				if (this.refreshQueued) {
					this.refreshQueued = false;
					this.refreshAndBroadcast();
				}
			});
	}

	private broadcastSystemStats(): void {
		const message = this.createSystemStatsMessage();
		const hash = JSON.stringify(message);
		if (hash === this.lastStatsHash) return;
		this.lastStatsHash = hash;

		const data = JSON.stringify(message);
		for (const client of this.clients) {
			if (!this.sendToClient(client, message, data)) {
				this.clients.delete(client);
				this.droppedClients++;
			}
		}
	}

	private sendToClient(client: WsClient, _message: SessionsWsMessage | Record<string, unknown>, data?: string): boolean {
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
	private historyDepths = new Map<string, number>();
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
		const depth = this.historyDepths.get(target) ?? DEFAULT_HISTORY_DEPTH;
		const output = capturePaneOutput(target, depth) ?? '';
		this.sendToClient(client, { type: 'output', output, timestamp: Date.now() });
		return true;
	}

	setHistoryDepth(target: string, lines: number): void {
		if (!this.clients.has(target)) return;
		const requested = Math.max(DEFAULT_HISTORY_DEPTH, Math.min(MAX_HISTORY_DEPTH, Math.floor(lines)));
		const current = this.historyDepths.get(target) ?? DEFAULT_HISTORY_DEPTH;
		if (requested <= current) return;
		this.historyDepths.set(target, requested);
		// Defer capture off the message dispatch path; lastOutput diffing in
		// pollAndBroadcast handles dedup against a concurrent poll tick.
		queueMicrotask(() => {
			if (this.clients.has(target)) this.pollAndBroadcast(target);
		});
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
					this.historyDepths.delete(target);
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
						this.historyDepths.delete(t);
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
		const depth = this.historyDepths.get(target) ?? DEFAULT_HISTORY_DEPTH;
		const output = capturePaneOutput(target, depth) ?? '';
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
				this.historyDepths.delete(target);
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

export interface WsMessageHandlers {
	resize?: (cols: number, rows: number) => void;
	setHistory?: (lines: number) => void;
}

export function handleWsMessage(msgStr: string, handlers?: WsMessageHandlers): 'pong' | null {
	if (msgStr === 'ping') return 'pong';
	if (!handlers) return null;

	try {
		const msg = JSON.parse(msgStr) as ResizeMessage | SetHistoryMessage;
		switch (msg.type) {
			case 'resize':
				if (handlers.resize && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
					handlers.resize(msg.cols, msg.rows);
				}
				break;
			case 'set_history':
				if (handlers.setHistory && typeof msg.lines === 'number') {
					handlers.setHistory(msg.lines);
				}
				break;
		}
	} catch {
		// malformed JSON
	}

	return null;
}

// ============================================================================
// URL Parsing
// ============================================================================

export type WsPathResult =
	| { type: 'sessions' }
	| { type: 'terminal'; target: string }
	| null;

export function parseWsPath(pathname: string): WsPathResult {
	if (pathname === '/api/sessions/stream') {
		return { type: 'sessions' };
	}

	const termMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
	if (termMatch) {
		return { type: 'terminal', target: decodeURIComponent(termMatch[1]) };
	}

	return null;
}

