/**
 * Shared WebSocket handler logic for both dev (ws) and production (Bun) servers.
 * Abstracts the WebSocket-specific APIs behind a simple interface.
 *
 * Features:
 * - Max clients limit to prevent server overload
 * - Structured error logging
 * - Backpressure handling for slow clients
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';

const execFileAsync = promisify(execFile);
import { getAllSessions, updateSession, readLinks, cleanupStaleSessions, type Session } from '../db/index.js';
import { checkForInterruption, checkForInterruptionAsync, getPaneTitle, getAllPaneTitles, detectRemoteControlUrl, capturePaneContentAsync, isPaneShowingSpinner, capturePaneContent } from '../tmux/pane.js';
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
		// If hook says idle but pane shows a spinner (e.g. compaction), override to busy
		if (session.state === 'idle') {
			const content = capturePaneContent(session.tmux_target);
			if (content) {
				const bottom = content.split('\n').slice(-6).join('\n');
				// DEBUG: log bottom of pane when idle to discover compaction indicator
				const fs = require('fs');
				fs.appendFileSync('/tmp/claude-mux-debug-idle.log',
					`[${new Date().toISOString()}] session=${session.id} bottom=\n${bottom}\n---\n`);
				if (isPaneShowingSpinner(content)) {
					updateSession(session.id, { state: 'busy', current_action: 'Compacting...' });
				}
			}
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

export function getEnrichedSessions(): (Session & { pane_title: string | null; pane_alive: boolean })[] {
	syncSessionStates();
	const sessions = getAllSessions();
	const links = readLinks();

	const enrichedSessions = sessions.map((s) => {
		const paneTitle = s.tmux_target ? getPaneTitle(s.tmux_target) : null;
		const enriched: Session & { pane_title: string | null; pane_alive: boolean } = {
			...s,
			pane_title: paneTitle,
			pane_alive: s.tmux_target ? paneTitle !== null : true,
		};

		// Merge linked_to from links file (orchestratorTarget → mainTarget)
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

/**
 * Async version of syncSessionStates. Does not block the event loop.
 * Runs all interruption checks concurrently.
 */
async function syncSessionStatesAsync(): Promise<void> {
	const sessions = getAllSessions().filter((s) => s.tmux_target);
	await Promise.all(
		sessions.map(async (session) => {
			if (!session.tmux_target) return;
			const content = await capturePaneContentAsync(session.tmux_target);
			if (!content) return;
			// Check for interruption (busy → idle)
			if (session.state !== 'idle') {
				const update = await checkForInterruptionAsync(session.tmux_target);
				if (update) {
					updateSession(session.id, update);
				}
			}
			// If hook says idle but pane shows a spinner (e.g. compaction), override to busy
			if (session.state === 'idle' && isPaneShowingSpinner(content)) {
				updateSession(session.id, { state: 'busy', current_action: 'Compacting...' });
			}
		})
	);
}

/**
 * Async version of getEnrichedSessions. Uses batched tmux calls
 * and concurrent interruption checks to avoid blocking the event loop.
 */
export async function getEnrichedSessionsAsync(): Promise<(Session & { pane_title: string | null; pane_alive: boolean })[]> {
	// Run interrupt checks and pane title batch fetch concurrently
	const [, paneTitles] = await Promise.all([
		syncSessionStatesAsync(),
		getAllPaneTitles()
	]);

	const sessions = getAllSessions();
	const links = readLinks();

	// Scan for Remote Control URLs in pane content (detect new URLs and clear stale ones)
	await Promise.all(
		sessions
			.filter((s) => s.tmux_target)
			.map(async (s) => {
				const content = await capturePaneContentAsync(s.tmux_target!);
				if (!content) return;
				const rcUrl = detectRemoteControlUrl(content);
				if (rcUrl && rcUrl !== s.rc_url) {
					updateSession(s.id, { rc_url: rcUrl });
					s.rc_url = rcUrl;
				} else if (!rcUrl && s.rc_url) {
					updateSession(s.id, { rc_url: null });
					s.rc_url = null;
				}
			})
	);

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

export function capturePaneOutput(target: string): string | null {
	try {
		return execFileSync('tmux', ['capture-pane', '-t', target, '-p', '-e', '-S', '-150'], {
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
		// Send initial state synchronously so client gets data immediately
		// Send initial sessions state + current system stats
		this.sendToClient(client, this.createSessionsMessage('connected'));
		this.sendToClient(client, this.createSystemStatsMessage());
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

	/** Sync version for initial client connect (one-time cost) */
	private createSessionsMessage(type: 'sessions' | 'connected') {
		const sessions = getEnrichedSessions();
		this.mergeQueueCounts(sessions);
		return { type, sessions, count: sessions.length, timestamp: Date.now() };
	}

	private async createSessionsMessageAsync(type: 'sessions' | 'connected') {
		const sessions = await getEnrichedSessionsAsync();
		return { type, sessions, count: sessions.length, timestamp: Date.now() };
	}

	private createSystemStatsMessage(): SystemStatsMessage {
		return { type: 'systemStats' as const, ...cachedSystemStats, timestamp: Date.now() };
	}

	private refreshAndBroadcast(): void {
		// Guard against overlapping async refresh cycles
		if (this.refreshing) return;
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
// Beads Types and Helpers
// ============================================================================

export type { ResolvedDep, BeadsIssue, BeadsMessage } from '../types/beads.js';
import type { ResolvedDep, BeadsIssue, BeadsMessage } from '../types/beads.js';

/** Raw issue from `bd list --json` */
interface BdListIssue {
	id: string;
	title: string;
	description?: string;
	status: string;
	priority: number;
	issue_type: string;
	owner?: string;
	assignee?: string;
	created_at?: string;
	updated_at?: string;
	dependencies?: { issue_id: string; depends_on_id: string; type: string }[];
	dependency_count: number;
	dependent_count: number;
}

/** Resolved issue from `bd show --json` dependents/dependencies arrays */
interface BdShowResolved {
	id: string;
	title: string;
	description?: string;
	status: string;
	priority?: number;
	issue_type: string;
	owner?: string;
	assignee?: string;
	created_at?: string;
	updated_at?: string;
	dependency_type: string;
}

/** Full issue from `bd show --json` */
interface BdShowIssue {
	id: string;
	title: string;
	description?: string;
	status: string;
	priority: number;
	issue_type: string;
	owner?: string;
	assignee?: string;
	created_at?: string;
	updated_at?: string;
	dependencies?: BdShowResolved[];
	dependents?: BdShowResolved[];
}

/**
 * Build epic_children / parent_epic_id from bd list dependency data alone.
 * Children declare a parent-child dependency pointing to the epic, so we scan
 * all issues for parent-child deps whose depends_on_id is an epic.
 */
function buildEpicRelationships(listIssues: BdListIssue[]): {
	epicChildrenMap: Map<string, string[]>;
	parentEpicMap: Map<string, string>;
} {
	const epicChildrenMap = new Map<string, string[]>();
	const parentEpicMap = new Map<string, string>();

	const epicIds = new Set(listIssues.filter((i) => i.issue_type === 'epic').map((i) => i.id));

	for (const issue of listIssues) {
		if (!issue.dependencies) continue;
		for (const dep of issue.dependencies) {
			if (dep.type === 'parent-child' && epicIds.has(dep.depends_on_id)) {
				const epicId = dep.depends_on_id;
				if (!epicChildrenMap.has(epicId)) epicChildrenMap.set(epicId, []);
				epicChildrenMap.get(epicId)!.push(issue.id);
				if (!parentEpicMap.has(issue.id)) {
					parentEpicMap.set(issue.id, epicId);
				}
			}
		}
	}

	return { epicChildrenMap, parentEpicMap };
}

/**
 * Convert bd list issues to BeadsIssue[] with optional bd show enrichment.
 * Builds epic relationships internally — uses showMap data when available (more accurate),
 * otherwise falls back to bd list dependency data.
 */
function mapToBeadsIssues(
	listIssues: BdListIssue[],
	showMap: Map<string, BdShowIssue> | null
): BeadsIssue[] {
	const epicChildrenMap = new Map<string, string[]>();
	const parentEpicMap = new Map<string, string>();
	// Track whether a task is a direct child or transitive dependency of its epic
	const epicRelationMap = new Map<string, 'child' | 'dependency'>();

	if (showMap && showMap.size > 0) {
		// Build from resolved show data (more accurate)
		// Children are in the epic's dependents with dependency_type 'parent-child'
		for (const issue of listIssues) {
			if (issue.issue_type !== 'epic') continue;
			const showData = showMap.get(issue.id);
			if (!showData?.dependents) continue;
			const childIds = showData.dependents
				.filter((d) => d.dependency_type === 'parent-child')
				.map((d) => d.id);
			epicChildrenMap.set(issue.id, childIds);
			for (const childId of childIds) {
				if (!parentEpicMap.has(childId)) {
					parentEpicMap.set(childId, issue.id);
				}
				epicRelationMap.set(childId, 'child');
			}
		}

		// BFS: walk blocks dependents from epic children to collect transitive dependencies
		for (const [epicId, seedIds] of epicChildrenMap) {
			const queue = [...seedIds];
			const visited = new Set(seedIds);
			visited.add(epicId);

			while (queue.length > 0) {
				const current = queue.shift()!;
				const currentShow = showMap.get(current);
				if (!currentShow?.dependents) continue;

				for (const dep of currentShow.dependents) {
					if (dep.dependency_type === 'parent-child') continue;
					if (visited.has(dep.id)) continue;
					visited.add(dep.id);

					epicChildrenMap.get(epicId)!.push(dep.id);
					if (!parentEpicMap.has(dep.id)) {
						parentEpicMap.set(dep.id, epicId);
					}
					epicRelationMap.set(dep.id, 'dependency');
					queue.push(dep.id);
				}
			}
		}
	} else {
		// Fall back to bd list dependency data
		const { epicChildrenMap: ecm, parentEpicMap: pem } = buildEpicRelationships(listIssues);
		for (const [k, v] of ecm) epicChildrenMap.set(k, v);
		for (const [k, v] of pem) parentEpicMap.set(k, v);
		// Mark all from fallback as children (no dependency data available)
		for (const [, childIds] of ecm) {
			for (const childId of childIds) {
				epicRelationMap.set(childId, 'child');
			}
		}

		// Fallback BFS using bd list dependencies (reverse direction)
		const epicIds = new Set(listIssues.filter((i) => i.issue_type === 'epic').map((i) => i.id));
		// Build reverse map: depends_on_id → issue IDs that depend on it (blocks relationship)
		const blockedByMap = new Map<string, string[]>();
		for (const issue of listIssues) {
			if (!issue.dependencies) continue;
			for (const dep of issue.dependencies) {
				if (dep.type === 'parent-child') continue;
				if (!blockedByMap.has(dep.depends_on_id)) blockedByMap.set(dep.depends_on_id, []);
				blockedByMap.get(dep.depends_on_id)!.push(issue.id);
			}
		}
		for (const [epicId, seedIds] of epicChildrenMap) {
			const queue = [...seedIds];
			const visited = new Set(seedIds);
			visited.add(epicId);

			while (queue.length > 0) {
				const current = queue.shift()!;
				const dependents = blockedByMap.get(current) ?? [];
				for (const depId of dependents) {
					if (visited.has(depId)) continue;
					if (epicIds.has(depId)) continue;
					visited.add(depId);

					epicChildrenMap.get(epicId)!.push(depId);
					if (!parentEpicMap.has(depId)) {
						parentEpicMap.set(depId, epicId);
					}
					epicRelationMap.set(depId, 'dependency');
					queue.push(depId);
				}
			}
		}
	}

	const listIds = new Set(listIssues.map((i) => i.id));

	// Collect missing epic children (e.g. closed issues not in bd list) from bd show dependents
	const missingChildrenMap = new Map<string, { dep: BdShowResolved; epicId: string }>();
	if (showMap && showMap.size > 0) {
		for (const issue of listIssues) {
			if (issue.issue_type !== 'epic') continue;
			const showData = showMap.get(issue.id);
			if (!showData?.dependents) continue;
			for (const dep of showData.dependents) {
				if (dep.dependency_type === 'parent-child' && !listIds.has(dep.id)) {
					missingChildrenMap.set(dep.id, { dep, epicId: issue.id });
				}
			}
		}
	}

	const results = listIssues.map((li): BeadsIssue => {
		const showData = showMap?.get(li.id);
		const isEpic = li.issue_type === 'epic';

		let needs: ResolvedDep[] = [];
		let unblocks: ResolvedDep[] = [];

		if (showData && !isEpic) {
			if (showData.dependencies) {
				needs = showData.dependencies
					.filter((d) => d.issue_type !== 'epic')
					.map((d) => ({
						id: d.id,
						title: d.title,
						status: d.status as BeadsIssue['status'],
						type: d.issue_type
					}));
			}
			if (showData.dependents) {
				unblocks = showData.dependents.map((d) => ({
					id: d.id,
					title: d.title,
					status: d.status as BeadsIssue['status'],
					type: d.issue_type
				}));
			}
		}

		return {
			id: li.id,
			title: li.title,
			description: li.description,
			status: li.status as BeadsIssue['status'],
			priority: li.priority,
			issue_type: li.issue_type,
			owner: li.owner,
			assignee: li.assignee,
			created_at: li.created_at,
			updated_at: li.updated_at,
			needs,
			unblocks,
			...(isEpic ? { epic_children: epicChildrenMap.get(li.id) ?? [] } : {}),
			...(parentEpicMap.has(li.id) ? { parent_epic_id: parentEpicMap.get(li.id) } : {}),
			...(epicRelationMap.has(li.id) ? { epic_relation: epicRelationMap.get(li.id) } : {})
		};
	});

	// Synthesize BeadsIssue objects for missing children (closed/deferred not in bd list)
	for (const [, { dep, epicId }] of missingChildrenMap) {
		results.push({
			id: dep.id,
			title: dep.title,
			description: dep.description,
			status: dep.status as BeadsIssue['status'],
			priority: dep.priority ?? 4,
			issue_type: dep.issue_type,
			owner: dep.owner,
			assignee: dep.assignee,
			created_at: dep.created_at,
			updated_at: dep.updated_at,
			needs: [],
			unblocks: [],
			parent_epic_id: epicId
		});
	}

	return results;
}

/**
 * Fast sync fetch: bd list only. Returns issues with epic grouping but no resolved dep titles.
 */
/**
 * Ensure the beads DB is in sync with the JSONL file.
 * When another process (e.g., Claude session) modifies issues.jsonl,
 * the server's bd database becomes stale and bd list --no-daemon fails.
 */
function syncBeadsDb(projectPath: string): void {
	try {
		execFileSync('bd', ['sync', '--import-only'], {
			encoding: 'utf-8',
			cwd: projectPath,
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 5000
		});
	} catch {
		// Sync failed — bd list may still work if DB is already current
	}
}

async function syncBeadsDbAsync(projectPath: string): Promise<void> {
	try {
		await execFileAsync('bd', ['sync', '--import-only'], {
			encoding: 'utf-8',
			cwd: projectPath,
			timeout: 5000
		});
	} catch {
		// Sync failed — bd list may still work if DB is already current
	}
}

export function getBeadsIssuesBasic(projectPath: string): BeadsIssue[] {
	syncBeadsDb(projectPath);
	let listIssues: BdListIssue[];
	try {
		const result = execFileSync('bd', ['list', '--json', '--limit', '0', '--all', '--no-daemon'], {
			encoding: 'utf-8',
			cwd: projectPath,
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 5000
		});
		listIssues = JSON.parse(result) as BdListIssue[];
	} catch {
		return [];
	}
	if (listIssues.length === 0) return [];
	return mapToBeadsIssues(listIssues, null);
}

/**
 * Full async fetch: bd list + bd show. Returns issues with resolved dependency titles.
 * Non-blocking — does not stall the event loop.
 */
export async function getBeadsIssues(projectPath: string): Promise<BeadsIssue[]> {
	// Ensure DB is in sync with JSONL before querying
	await syncBeadsDbAsync(projectPath);

	// Step 1: async bd list
	let listIssues: BdListIssue[];
	try {
		const { stdout } = await execFileAsync('bd', ['list', '--json', '--limit', '0', '--all', '--no-daemon'], {
			encoding: 'utf-8',
			cwd: projectPath,
			timeout: 5000
		});
		listIssues = JSON.parse(stdout) as BdListIssue[];
	} catch {
		return [];
	}
	if (listIssues.length === 0) return [];

	// Step 2: async bd show for enrichment
	let showMap: Map<string, BdShowIssue> | null = null;
	try {
		const ids = listIssues.map((i) => i.id);
		const { stdout } = await execFileAsync('bd', ['show', ...ids, '--json', '--no-daemon'], {
			encoding: 'utf-8',
			cwd: projectPath,
			timeout: 10000
		});
		const showIssues = JSON.parse(stdout) as BdShowIssue[];
		showMap = new Map(showIssues.map((i) => [i.id, i]));
	} catch {
		// Fallback: no enrichment
	}

	return mapToBeadsIssues(listIssues, showMap);
}

// ============================================================================
// Beads Watcher (per-project file watching)
// ============================================================================

import { existsSync, statSync } from 'fs';
import { join } from 'path';

interface BeadsWatcherCallback {
	(): void;
}

class BeadsProjectWatcher {
	private subscribers = new Map<string, Set<BeadsWatcherCallback>>();
	private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private lastMtime = new Map<string, number>();
	private readonly pollInterval = 1000;
	private readonly debounceMs = 300;

	/**
	 * Subscribe to changes in a project's beads issues
	 */
	subscribe(projectPath: string, callback: BeadsWatcherCallback): () => void {
		if (!this.subscribers.has(projectPath)) {
			this.subscribers.set(projectPath, new Set());
		}
		this.subscribers.get(projectPath)!.add(callback);

		// Start watching if first subscriber for this project
		if (this.subscribers.get(projectPath)!.size === 1) {
			this.startWatching(projectPath);
		}

		return () => {
			const subs = this.subscribers.get(projectPath);
			if (subs) {
				subs.delete(callback);
				if (subs.size === 0) {
					this.stopWatching(projectPath);
					this.subscribers.delete(projectPath);
				}
			}
		};
	}

	private startWatching(projectPath: string): void {
		const issuesFile = join(projectPath, '.beads', 'issues.jsonl');

		// Get initial mtime
		try {
			if (existsSync(issuesFile)) {
				this.lastMtime.set(projectPath, statSync(issuesFile).mtimeMs);
			}
		} catch {
			// File may not exist
		}

		console.log('[beads-watcher] Started watching', projectPath);

		const timer = setInterval(() => {
			this.checkForChanges(projectPath, issuesFile);
		}, this.pollInterval);

		this.pollTimers.set(projectPath, timer);
	}

	private stopWatching(projectPath: string): void {
		const timer = this.pollTimers.get(projectPath);
		if (timer) {
			clearInterval(timer);
			this.pollTimers.delete(projectPath);
		}
		const debounce = this.debounceTimers.get(projectPath);
		if (debounce) {
			clearTimeout(debounce);
			this.debounceTimers.delete(projectPath);
		}
		this.lastMtime.delete(projectPath);
		console.log('[beads-watcher] Stopped watching', projectPath);
	}

	private checkForChanges(projectPath: string, issuesFile: string): void {
		try {
			if (!existsSync(issuesFile)) {
				// File was deleted, notify
				if (this.lastMtime.has(projectPath)) {
					this.lastMtime.delete(projectPath);
					this.notifySubscribers(projectPath);
				}
				return;
			}

			const currentMtime = statSync(issuesFile).mtimeMs;
			const lastMtime = this.lastMtime.get(projectPath);

			if (lastMtime === undefined || currentMtime !== lastMtime) {
				this.lastMtime.set(projectPath, currentMtime);
				if (lastMtime !== undefined) {
					// Only notify on changes, not initial read
					console.log('[beads-watcher] Issues changed in', projectPath);
					this.notifySubscribers(projectPath);
				}
			}
		} catch {
			// Ignore errors during polling
		}
	}

	private notifySubscribers(projectPath: string): void {
		// Debounce: collapse rapid file changes into a single notification
		const existing = this.debounceTimers.get(projectPath);
		if (existing) clearTimeout(existing);

		this.debounceTimers.set(
			projectPath,
			setTimeout(() => {
				this.debounceTimers.delete(projectPath);
				const subs = this.subscribers.get(projectPath);
				if (subs) {
					for (const callback of subs) {
						try {
							callback();
						} catch (error) {
							console.error('[beads-watcher] Subscriber error:', error);
						}
					}
				}
			}, this.debounceMs)
		);
	}
}

export const beadsWatcher = new BeadsProjectWatcher();

// ============================================================================
// Beads WebSocket Manager
// ============================================================================

export class BeadsWsManager {
	private clients = new Map<string, Set<WsClient>>();
	private unsubscribes = new Map<string, () => void>();
	private lastHash = new Map<string, string>();
	private config: Required<WsConfig>;
	private totalClients = 0;

	constructor(config?: WsConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	getStats(): { totalClients: number; projects: number } {
		return {
			totalClients: this.totalClients,
			projects: this.clients.size
		};
	}

	addClient(client: WsClient, projectPath: string): boolean {
		if (!projectPath) return false;

		if (!this.clients.has(projectPath)) {
			this.clients.set(projectPath, new Set());
		}

		this.clients.get(projectPath)!.add(client);
		this.totalClients++;

		log(
			{
				level: 'debug',
				component: 'beads',
				message: 'Client connected',
				data: { project: projectPath, total: this.totalClients }
			},
			this.config
		);

		// Subscribe to watcher if first client for this project
		if (this.clients.get(projectPath)!.size === 1 && !this.unsubscribes.has(projectPath)) {
			console.log('[ws:beads] First client for project, subscribing to watcher');
			const unsub = beadsWatcher.subscribe(projectPath, () =>
				this.refreshAndBroadcast(projectPath)
			);
			this.unsubscribes.set(projectPath, unsub);
		}

		// Send basic issues immediately (fast, sync)
		this.sendToClient(client, this.createMessageBasic(projectPath, 'connected'));

		// Kick off async enrichment in background
		this.enrichAndBroadcast(projectPath);
		return true;
	}

	removeClient(client: WsClient, projectPath?: string): void {
		if (projectPath) {
			const projectClients = this.clients.get(projectPath);
			if (projectClients && projectClients.delete(client)) {
				this.totalClients--;

				if (projectClients.size === 0) {
					this.clients.delete(projectPath);
					this.lastHash.delete(projectPath);

					const unsub = this.unsubscribes.get(projectPath);
					if (unsub) {
						unsub();
						this.unsubscribes.delete(projectPath);
					}
				}
			}
		} else {
			// Find and remove from any project
			for (const [project, clients] of this.clients) {
				if (clients.delete(client)) {
					this.totalClients--;
					if (clients.size === 0) {
						this.clients.delete(project);
						this.lastHash.delete(project);

						const unsub = this.unsubscribes.get(project);
						if (unsub) {
							unsub();
							this.unsubscribes.delete(project);
						}
					}
					break;
				}
			}
		}
	}

	private createMessageBasic(projectPath: string, type: 'issues' | 'connected'): BeadsMessage {
		const issues = getBeadsIssuesBasic(projectPath);
		return { type, issues, project: projectPath, timestamp: Date.now() };
	}

	private async enrichAndBroadcast(projectPath: string): Promise<void> {
		try {
			const issues = await getBeadsIssues(projectPath);
			this.broadcastIssues(projectPath, issues);
		} catch (err) {
			console.error('[ws:beads] Enrichment failed:', err);
		}
	}

	private refreshAndBroadcast(projectPath: string): void {
		// Fire async enrichment — non-blocking
		this.enrichAndBroadcast(projectPath);
	}

	private broadcastIssues(projectPath: string, issues: BeadsIssue[]): void {
		const message: BeadsMessage = { type: 'issues', issues, project: projectPath, timestamp: Date.now() };
		const hash = JSON.stringify(issues);

		if (hash === this.lastHash.get(projectPath)) {
			return;
		}

		this.lastHash.set(projectPath, hash);
		const data = JSON.stringify(message);

		const clients = this.clients.get(projectPath);
		if (clients) {
			console.log('[ws:beads] Broadcasting to', clients.size, 'clients for', projectPath);
			for (const client of clients) {
				if (!this.sendToClient(client, message, data)) {
					clients.delete(client);
					this.totalClients--;
				}
			}

			if (clients.size === 0) {
				this.clients.delete(projectPath);
				this.lastHash.delete(projectPath);

				const unsub = this.unsubscribes.get(projectPath);
				if (unsub) {
					unsub();
					this.unsubscribes.delete(projectPath);
				}
			}
		}
	}

	private sendToClient(client: WsClient, _message: BeadsMessage, data?: string): boolean {
		try {
			if (!client.isOpen()) return false;

			if (client.getBufferedAmount) {
				const buffered = client.getBufferedAmount();
				if (buffered > 64 * 1024) {
					return false;
				}
			}

			client.send(data ?? JSON.stringify(_message));
			return true;
		} catch {
			return false;
		}
	}
}

// ============================================================================
// URL Parsing
// ============================================================================

export type WsPathResult =
	| { type: 'sessions' }
	| { type: 'terminal'; target: string }
	| { type: 'beads'; project: string }
	| null;

export function parseWsPath(pathname: string, searchParams?: URLSearchParams): WsPathResult {
	if (pathname === '/api/sessions/stream') {
		return { type: 'sessions' };
	}

	if (pathname === '/api/beads/stream') {
		const project = searchParams?.get('project');
		if (project) {
			return { type: 'beads', project: decodeURIComponent(project) };
		}
		return null;
	}

	const termMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
	if (termMatch) {
		return { type: 'terminal', target: decodeURIComponent(termMatch[1]) };
	}

	return null;
}
