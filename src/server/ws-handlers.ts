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
import { getAllSessions, getSession, updateSession, readLinks, cleanupStaleSessions, type Session } from '../db/index.js';
import { TranscriptBuilder, type TranscriptEntry } from '../transcript/parser.js';
import { JsonlTailer, listSubagents, transcriptPathFor, type SubagentMeta } from '../transcript/tailer.js';
import { getAllPaneTitles, detectRemoteControlUrl, capturePaneContentAsync, isPaneShowingSpinner, isPaneShowingIdlePrompt, detectRecentInterruption } from '../tmux/pane.js';
import { resizeTmuxWindow } from '../tmux/resize.js';
import { snapshotPane, fetchHistoryRange } from '../tmux/snapshot.js';
import { sessionWatcher } from './watcher.js';
import { getQueueCounts } from './message-queue.js';
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

/** Visible pane changed (or initial). `historySize` is the absolute index right after the last history line. */
export interface ScreenMessage {
	type: 'screen';
	lines: string[];
	historySize: number;
	alt: boolean;
	cols: number;
	rows: number;
	timestamp: number;
}

/** A contiguous block of history lines [start, start+lines.length). */
export interface HistoryMessage {
	type: 'history';
	start: number;
	lines: string[];
	historySize: number;
	timestamp: number;
}

/** History became invalid (pane reflowed on resize, cleared, alt-screen toggled). Client drops history and re-requests. */
export interface ResetMessage {
	type: 'reset';
	historySize: number;
	alt: boolean;
	cols: number;
	rows: number;
	timestamp: number;
}

export type TerminalMessage = ScreenMessage | HistoryMessage | ResetMessage;

export interface ResizeMessage {
	type: 'resize';
	cols: number;
	rows: number;
}

/** Client asks for `count` history lines ending right before absolute index `before`. */
interface HistoryRequestMessage {
	type: 'history_request';
	before: number;
	count: number;
}

const DEFAULT_HISTORY_DEPTH = 200;
const MAX_HISTORY_DEPTH = 5000;
/** Max lines served per history_request */
const MAX_HISTORY_REQUEST = 1000;

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

/** Consecutive ticks a busy session's pane has looked idle (Esc edge case). */
const idleLookTicks = new Map<string, number>();

/**
 * Capture each target's pane once per refresh and run all content-derived
 * checks (interruption, spinner, RC URL) off that single capture instead of
 * re-spawning `tmux capture-pane` three times per session per tick.
 */
async function captureAndSyncSessions(): Promise<{
	captures: Map<string, string>;
	sessions: Session[];
}> {
	const sessions = getAllSessions();
	const captures = new Map<string, string>();

	/** Persist and mirror onto the in-memory copy, so callers need no re-read. */
	const apply = (session: Session, patch: Partial<Session>) => {
		updateSession(session.id, patch);
		Object.assign(session, patch);
	};

	await Promise.all(
		sessions.map(async (session) => {
			if (!session.tmux_target) return;
			const content = await capturePaneContentAsync(session.tmux_target);
			if (!content) return;
			captures.set(session.tmux_target, content);

			if (session.state !== 'idle' && detectRecentInterruption(content)) {
				apply(session, { state: 'idle', current_action: null, prompt_text: null });
			} else if (session.state === 'busy' && isPaneShowingIdlePrompt(content)) {
				// Esc during thinking leaves no "Interrupted" marker; the pane just
				// returns to the ready prompt. Debounce two ticks to avoid flapping
				// on transient frames between tools.
				const ticks = (idleLookTicks.get(session.id) ?? 0) + 1;
				if (ticks >= 2) {
					idleLookTicks.delete(session.id);
					apply(session, { state: 'idle', current_action: null, prompt_text: null });
				} else {
					idleLookTicks.set(session.id, ticks);
				}
			} else {
				idleLookTicks.delete(session.id);
			}
			// If hook says idle but pane shows a spinner (e.g. compaction), override to busy
			if (session.state === 'idle' && isPaneShowingSpinner(content)) {
				apply(session, { state: 'busy', current_action: 'Compacting...' });
			}
		})
	);

	// Drop debounce counters for sessions that vanished mid-count.
	if (idleLookTicks.size > 0) {
		const live = new Set(sessions.map((s) => s.id));
		for (const id of idleLookTicks.keys()) {
			if (!live.has(id)) idleLookTicks.delete(id);
		}
	}

	return { captures, sessions };
}

/**
 * Async version of getEnrichedSessions. Uses batched tmux calls
 * and concurrent interruption checks to avoid blocking the event loop.
 */
export async function getEnrichedSessionsAsync(): Promise<(Session & { pane_title: string | null; pane_alive: boolean })[]> {
	const [{ captures, sessions }, paneTitles] = await Promise.all([
		captureAndSyncSessions(),
		getAllPaneTitles()
	]);

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

	/**
	 * Public trigger for an immediate fresh broadcast. Used by API mutation
	 * endpoints (rename/kill/restart) so the UI updates instantly instead of
	 * waiting up to 500ms for the file watcher poll to detect mtime change.
	 */
	broadcastNow(): void {
		this.refreshAndBroadcast();
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
				// (queue draining runs in its own server loop — see message-queue.ts ensureDrainLoop)

				// Merge queue counts into session data for broadcast
				this.mergeQueueCounts(message.sessions);

				const hash = JSON.stringify(message.sessions);
				if (hash === this.lastHash) {
					return;
				}
				this.lastHash = hash;
				const data = JSON.stringify(message);

				const drops: WsClient[] = [];
				for (const client of [...this.clients]) {
					if (!this.sendToClient(client, message, data)) drops.push(client);
				}
				for (const client of drops) {
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
		const drops: WsClient[] = [];
		for (const client of [...this.clients]) {
			if (!this.sendToClient(client, message, data)) drops.push(client);
		}
		for (const client of drops) {
			this.clients.delete(client);
			this.droppedClients++;
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

/**
 * Send one JSON message to a client, dropping it when the socket is closed,
 * backed up, or throwing. Shared by every channel manager so the backpressure
 * policy has one definition.
 */
function sendJson(
	client: WsClient,
	message: unknown,
	config: Required<WsConfig>,
	opts: { component: string; maxBuffered: number; data?: string }
): boolean {
	try {
		if (!client.isOpen()) return false;
		if (client.getBufferedAmount) {
			const buffered = client.getBufferedAmount();
			if (buffered > opts.maxBuffered) {
				log(
					{
						level: 'warn',
						component: opts.component,
						message: 'Client backpressure detected',
						data: { buffered }
					},
					config
				);
				return false;
			}
		}
		client.send(opts.data ?? JSON.stringify(message));
		return true;
	} catch (err) {
		log(
			{
				level: 'error',
				component: opts.component,
				message: 'Failed to send to client',
				data: { error: String(err) }
			},
			config
		);
		return false;
	}
}

// ============================================================================
// Terminal WebSocket Manager
// ============================================================================

interface TargetState {
	historySize: number;
	alt: boolean;
	cols: number;
	rows: number;
	screenKey: string;
}

export class TerminalWsManager {
	private clients = new Map<string, Set<WsClient>>();
	private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
	private states = new Map<string, TargetState>();
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

		// Initial state: screen + the last DEFAULT_HISTORY_DEPTH history lines.
		const snap = snapshotPane(target);
		const now = Date.now();
		if (snap) {
			this.states.set(target, {
				historySize: snap.historySize,
				alt: snap.alt,
				cols: snap.cols,
				rows: snap.rows,
				screenKey: snap.screen.join('\n')
			});
			this.sendToClient(client, {
				type: 'screen',
				lines: snap.screen,
				historySize: snap.historySize,
				alt: snap.alt,
				cols: snap.cols,
				rows: snap.rows,
				timestamp: now
			});
			if (!snap.alt && snap.historySize > 0) {
				this.sendHistoryTail(client, target, snap.historySize, DEFAULT_HISTORY_DEPTH);
			}
		} else {
			// Pane gone / not capturable: send an empty screen so the UI renders
			this.sendToClient(client, {
				type: 'screen',
				lines: [],
				historySize: 0,
				alt: false,
				cols: 0,
				rows: 0,
				timestamp: now
			});
		}
		return true;
	}

	/**
	 * Serve a client's request for `count` history lines before absolute index `before`.
	 * Replies only to the requesting client (each viewer scrolls independently).
	 */
	requestHistory(client: WsClient, target: string, before: number, count: number): void {
		const state = this.states.get(target);
		if (!state || state.alt) return;
		const n = Math.max(1, Math.min(MAX_HISTORY_REQUEST, Math.floor(count)));
		const end = Math.max(0, Math.min(Math.floor(before), state.historySize));
		if (end === 0) return;
		this.sendHistoryTail(client, target, end, n);
	}

	private sendHistoryTail(client: WsClient, target: string, end: number, count: number): void {
		const state = this.states.get(target);
		const known = state?.historySize ?? end;
		const start = Math.max(0, end - count);
		const res = fetchHistoryRange(target, start, end, known);
		if (!res) return;
		this.sendToClient(client, {
			type: 'history',
			start: res.start,
			lines: res.lines,
			historySize: res.historySize,
			timestamp: Date.now()
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
					this.states.delete(target);
				}
			}
			return;
		}

		// Search all targets for the client
		for (const [t, clients] of this.clients) {
			if (clients.delete(client)) {
				this.totalClients--;
				if (clients.size === 0) {
					this.stopPolling(t);
					this.clients.delete(t);
					this.states.delete(t);
				}
				break;
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
		const snap = snapshotPane(target);
		if (!snap) return; // pane gone; keep last state, clients will see pane_alive=false via sessions stream
		const prev = this.states.get(target);
		const now = Date.now();
		const messages: TerminalMessage[] = [];
		const screenKey = snap.screen.join('\n');

		if (!prev) {
			this.states.set(target, { historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, screenKey });
			messages.push({ type: 'reset', historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, timestamp: now });
			messages.push({ type: 'screen', lines: snap.screen, historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, timestamp: now });
		} else {
			const reflowed =
				snap.alt !== prev.alt ||
				snap.cols !== prev.cols ||
				snap.rows !== prev.rows ||
				snap.historySize < prev.historySize;
			if (reflowed) {
				// Resize reflows history in tmux; `clear` drops it; alt-screen swaps buffers.
				messages.push({ type: 'reset', historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, timestamp: now });
			} else if (!snap.alt && snap.historySize > prev.historySize) {
				const n = snap.historySize - prev.historySize;
				let lines: string[] | null = null;
				let start = prev.historySize;
				if (n <= snap.tail.length) {
					lines = snap.tail.slice(snap.tail.length - n);
				} else {
					// Burst larger than the tail we snapshot each tick — fetch the rest explicitly.
					const res = fetchHistoryRange(target, prev.historySize, snap.historySize, snap.historySize);
					if (res) {
						lines = res.lines;
						start = res.start;
					}
				}
				if (lines) {
					messages.push({ type: 'history', start, lines, historySize: snap.historySize, timestamp: now });
				} else {
					messages.push({ type: 'reset', historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, timestamp: now });
				}
			}
			if (screenKey !== prev.screenKey || reflowed) {
				messages.push({ type: 'screen', lines: snap.screen, historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, timestamp: now });
			}
			this.states.set(target, { historySize: snap.historySize, alt: snap.alt, cols: snap.cols, rows: snap.rows, screenKey });
		}

		if (messages.length === 0) return;
		const clients = this.clients.get(target);
		if (!clients) return;
		for (const message of messages) {
			const data = JSON.stringify(message);
			const drops: WsClient[] = [];
			for (const client of [...clients]) {
				if (!this.sendToClient(client, message, data)) drops.push(client);
			}
			for (const client of drops) {
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
			if (clients.size === 0) {
				this.stopPolling(target);
				this.clients.delete(target);
				this.states.delete(target);
				return;
			}
		}
	}

	private sendToClient(client: WsClient, message: TerminalMessage, data?: string): boolean {
		return sendJson(client, message, this.config, {
			component: 'terminal',
			maxBuffered: 64 * 1024,
			data
		});
	}
}

// ============================================================================
// Transcript WebSocket Manager
// ============================================================================

/**
 * A subagent's work, condensed for the Task card that spawned it: what it ran
 * (summaries only — the parent card doesn't need every tool's full input) plus
 * the report it returned.
 */
export interface SubagentPayload {
	agentId: string;
	/** Parent Task tool_use id — the card this belongs under. */
	toolUseId: string | null;
	agentType: string | null;
	description: string | null;
	model: string | null;
	activity: { id: string; name: string; summary: string; ok: boolean | null }[];
	/** The subagent's final message: what it reported back. */
	report: string | null;
	running: boolean;
}

export type TranscriptWsMessage =
	| {
			type: 'snapshot';
			entries: TranscriptEntry[];
			subagents: SubagentPayload[];
			available: boolean;
			timestamp: number;
		}
	| { type: 'entries'; entries: TranscriptEntry[]; timestamp: number }
	| { type: 'subagents'; subagents: SubagentPayload[]; timestamp: number };

interface SubagentState {
	tailer: JsonlTailer;
	builder: TranscriptBuilder;
	meta: SubagentMeta;
	/** Serialized payload last sent, to skip unchanged broadcasts. */
	lastSent: string;
}

interface TranscriptSessionState {
	tailer: JsonlTailer;
	builder: TranscriptBuilder;
	timer: ReturnType<typeof setInterval>;
	available: boolean;
	/** Session cwd + id, for locating the subagents directory. */
	cwd: string | null;
	subagents: Map<string, SubagentState>;
	/** Ticks until the next subagents directory scan. */
	discoverIn: number;
}

const TRANSCRIPT_POLL_MS = 500;
/** Scan for newly spawned subagents every N polls (they appear rarely). */
const SUBAGENT_DISCOVER_TICKS = 4;

/** Condense a subagent's parsed transcript into what its Task card shows. */
function subagentPayload(agentId: string, state: SubagentState): SubagentPayload {
	const activity: SubagentPayload['activity'] = [];
	let report: string | null = null;
	for (const entry of state.builder.entries) {
		if (entry.kind === 'tool') {
			activity.push({
				id: entry.id,
				name: entry.name,
				summary: entry.summary,
				ok: entry.result ? entry.result.ok : null
			});
		} else if (entry.kind === 'text') {
			report = entry.text;
		}
	}
	// Still working while its newest tool has no result yet.
	const running = activity.length > 0 && activity[activity.length - 1].ok === null;
	return {
		agentId,
		toolUseId: state.meta.toolUseId ?? null,
		agentType: state.meta.agentType ?? null,
		description: state.meta.description ?? null,
		model: state.meta.model ?? null,
		activity,
		report,
		running
	};
}

/**
 * Streams parsed session transcripts (from ~/.claude/projects JSONL files) to
 * clients, keyed by claude-mux session id. Mirrors TerminalWsManager's
 * lifecycle: first client for a session starts the tailer, last one stops it.
 */
export class TranscriptWsManager {
	private clients = new Map<string, Set<WsClient>>();
	private sessions = new Map<string, TranscriptSessionState>();
	private config: Required<WsConfig>;

	constructor(config?: WsConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	addClient(client: WsClient, sessionId: string): boolean {
		const existing = this.clients.get(sessionId);
		if (existing && existing.size >= this.config.maxTerminalClientsPerTarget) {
			log(
				{
					level: 'warn',
					component: 'transcript',
					message: 'Max clients per session reached',
					data: { sessionId, current: existing.size }
				},
				this.config
			);
			return false;
		}

		if (!this.clients.has(sessionId)) this.clients.set(sessionId, new Set());
		this.clients.get(sessionId)!.add(client);

		let state = this.sessions.get(sessionId);
		if (!state) {
			state = this.startSession(sessionId);
			this.sessions.set(sessionId, state);
		}
		this.sendToClient(client, {
			type: 'snapshot',
			entries: state.builder.entries,
			subagents: [...state.subagents].map(([id, sub]) => subagentPayload(id, sub)),
			available: state.available,
			timestamp: Date.now()
		});
		return true;
	}

	removeClient(client: WsClient, sessionId?: string): void {
		const drop = (id: string, clients: Set<WsClient>) => {
			if (!clients.delete(client)) return false;
			if (clients.size === 0) this.stopSession(id);
			return true;
		};
		if (sessionId) {
			const clients = this.clients.get(sessionId);
			if (clients) drop(sessionId, clients);
			return;
		}
		for (const [id, clients] of this.clients) {
			if (drop(id, clients)) break;
		}
	}

	private startSession(sessionId: string): TranscriptSessionState {
		const session = getSession(sessionId);
		// An unknown session yields an unreadable path; the tailer reports
		// `missing` and the client gets an empty snapshot.
		const tailer = new JsonlTailer(session ? transcriptPathFor(session.cwd, sessionId) : '');
		const state: TranscriptSessionState = {
			tailer,
			builder: new TranscriptBuilder(),
			available: false,
			cwd: session?.cwd ?? null,
			subagents: new Map(),
			discoverIn: 0,
			timer: setInterval(() => this.poll(sessionId), TRANSCRIPT_POLL_MS)
		};
		// Synchronous initial read so the first snapshot carries history.
		this.consume(state, tailer.read());
		this.syncSubagents(sessionId, state);
		return state;
	}

	/**
	 * Pick up newly spawned subagents and tail the known ones. Returns the
	 * payloads that changed since the last call.
	 */
	private syncSubagents(sessionId: string, state: TranscriptSessionState): SubagentPayload[] {
		if (!state.cwd) return [];

		if (state.discoverIn <= 0) {
			state.discoverIn = SUBAGENT_DISCOVER_TICKS;
			for (const file of listSubagents(state.cwd, sessionId)) {
				const known = state.subagents.get(file.agentId);
				if (known) {
					// Meta lands after the transcript starts; keep the latest.
					known.meta = { ...known.meta, ...file.meta };
					continue;
				}
				state.subagents.set(file.agentId, {
					tailer: new JsonlTailer(file.path),
					builder: new TranscriptBuilder(true),
					meta: file.meta,
					lastSent: ''
				});
			}
		} else {
			state.discoverIn--;
		}

		const changed: SubagentPayload[] = [];
		for (const [agentId, sub] of state.subagents) {
			const result = sub.tailer.read();
			if (result.status === 'reset') {
				sub.builder = new TranscriptBuilder(true);
			} else if (result.status === 'lines') {
				for (const line of result.lines) sub.builder.feed(line);
			} else if (sub.lastSent !== '') {
				continue;
			}
			const payload = subagentPayload(agentId, sub);
			const encoded = JSON.stringify(payload);
			if (encoded === sub.lastSent) continue;
			sub.lastSent = encoded;
			changed.push(payload);
		}
		return changed;
	}

	private stopSession(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (state) clearInterval(state.timer);
		this.sessions.delete(sessionId);
		this.clients.delete(sessionId);
	}

	/** Apply a tail result to the builder; returns changed entry ids. */
	private consume(
		state: TranscriptSessionState,
		result: ReturnType<JsonlTailer['read']>
	): string[] {
		switch (result.status) {
			case 'lines': {
				state.available = true;
				const changed: string[] = [];
				for (const line of result.lines) changed.push(...state.builder.feed(line));
				return changed;
			}
			case 'reset':
				// File replaced: rebuild on the next polls from offset 0.
				state.builder = new TranscriptBuilder();
				return [];
			default:
				return [];
		}
	}

	private poll(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		const clients = this.clients.get(sessionId);
		if (!state || !clients || clients.size === 0) return;

		const result = state.tailer.read();
		if (result.status === 'reset') {
			this.consume(state, result);
			// Immediately re-read the fresh file and resend full snapshots.
			this.consume(state, state.tailer.read());
			this.broadcast(sessionId, {
				type: 'snapshot',
				entries: state.builder.entries,
				subagents: [...state.subagents].map(([id, sub]) => subagentPayload(id, sub)),
				available: state.available,
				timestamp: Date.now()
			});
			return;
		}

		const changedIds = this.consume(state, result);
		if (changedIds.length > 0) {
			const seen = new Set<string>();
			const entries: TranscriptEntry[] = [];
			for (const id of changedIds) {
				if (seen.has(id)) continue;
				seen.add(id);
				const entry = state.builder.getEntry(id);
				if (entry) entries.push(entry);
			}
			this.broadcast(sessionId, { type: 'entries', entries, timestamp: Date.now() });
		}

		const subagents = this.syncSubagents(sessionId, state);
		if (subagents.length > 0) {
			this.broadcast(sessionId, { type: 'subagents', subagents, timestamp: Date.now() });
		}
	}

	private broadcast(sessionId: string, message: TranscriptWsMessage): void {
		const clients = this.clients.get(sessionId);
		if (!clients) return;
		const data = JSON.stringify(message);
		for (const client of [...clients]) {
			if (!this.sendToClient(client, message, data)) {
				clients.delete(client);
			}
		}
		if (clients.size === 0) this.stopSession(sessionId);
	}

	private sendToClient(client: WsClient, message: TranscriptWsMessage, data?: string): boolean {
		return sendJson(client, message, this.config, {
			component: 'transcript',
			maxBuffered: 256 * 1024,
			data
		});
	}
}

// ============================================================================
// Message Handling
// ============================================================================

export interface WsMessageHandlers {
	resize?: (cols: number, rows: number) => void;
	historyRequest?: (before: number, count: number) => void;
}

export function handleWsMessage(msgStr: string, handlers?: WsMessageHandlers): 'pong' | null {
	if (msgStr === 'ping') return 'pong';
	if (!handlers) return null;

	try {
		const msg = JSON.parse(msgStr) as ResizeMessage | HistoryRequestMessage;
		switch (msg.type) {
			case 'resize':
				if (handlers.resize && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
					handlers.resize(msg.cols, msg.rows);
				}
				break;
			case 'history_request':
				if (handlers.historyRequest && typeof msg.before === 'number' && typeof msg.count === 'number') {
					handlers.historyRequest(msg.before, msg.count);
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
	| { type: 'transcript'; target: string }
	| null;

export function parseWsPath(pathname: string): WsPathResult {
	if (pathname === '/api/sessions/stream') {
		return { type: 'sessions' };
	}

	const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript\/stream$/);
	if (transcriptMatch) {
		return { type: 'transcript', target: decodeURIComponent(transcriptMatch[1]) };
	}

	const termMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
	if (termMatch) {
		return { type: 'terminal', target: decodeURIComponent(termMatch[1]) };
	}

	return null;
}

