/**
 * Message queue for sessions.
 * Messages are queued per tmux target and auto-sent when the session goes idle.
 *
 * The queue is kept in memory and mirrored to ~/.claude-mux/queue.json, so a
 * server restart does not silently swallow messages that were waiting for a
 * busy pane. Only one server owns the file at a time (see the ownership lock
 * below) — a second instance, such as the dev server running alongside the
 * systemd one, keeps its own in-memory queue and leaves the file alone rather
 * than racing to paste the same message twice.
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAllSessions } from '../db/index.js';
import { CLAUDE_MUX_DIR } from '../utils/paths.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Who put the message in the queue. `user` is something a human typed and is
 * waiting to see delivered; `control` is claude-mux talking to the agent on its
 * own behalf (today: mirroring a dashboard rename as `/rename`). The UI needs
 * the difference so it can stop reporting its own bookkeeping as your backlog.
 */
export type QueuedMessageKind = 'user' | 'control';

export interface QueuedMessage {
	text: string;
	queuedAt: number;
	kind: QueuedMessageKind;
	/** Failed send attempts, so a message aimed at a dead pane gives up. */
	attempts?: number;
}

interface SessionLike {
	tmux_target: string | null;
	state: string;
}

// ============================================================================
// Timing
// ============================================================================

const IDLE_GRACE_MS = 1000;
const RESEND_FALLBACK_MS = 10_000;
const DRAIN_INTERVAL_MS = 500;
/** How long a message may wait for its pane before it is assumed stale. */
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a target may be absent from the session list before its queue dies. */
const ORPHAN_GRACE_MS = 60_000;
/** Send attempts before an undeliverable message is dropped. */
const MAX_SEND_ATTEMPTS = 3;


// ============================================================================
// Shared tmux text injection helper
// ============================================================================

/**
 * Send text to a tmux pane using load-buffer → paste-buffer → send-keys Enter.
 * Extracted from the send API route to be reused by both the API and the queue drain.
 */
export function sendTextToPane(target: string, text: string, opts: { appendEnter?: boolean } = {}): void {
	const { appendEnter = true } = opts;
	execSync(`tmux load-buffer -b claude-mux-input -`, {
		input: text,
		stdio: ['pipe', 'ignore', 'ignore']
	});
	execFileSync('tmux', ['paste-buffer', '-b', 'claude-mux-input', '-t', target], {
		stdio: 'ignore'
	});
	execFileSync('tmux', ['delete-buffer', '-b', 'claude-mux-input'], { stdio: 'ignore' });
	if (appendEnter) {
		execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
	}
}

// ============================================================================
// Queue storage — shared via globalThis to survive Vite's dual module loading
// (Vite plugin uses native import, API routes use SSR module loader)
// ============================================================================

interface QueueGlobalState {
	queues: Map<string, QueuedMessage[]>;
	pendingDrain: Map<string, number>;
	/** target → timestamp of last auto-send; blocks re-send until session leaves idle */
	recentlySent: Map<string, number>;
	/** target → first tick at which no session claimed it, for orphan expiry */
	missingSince: Map<string, number>;
	drainTimer: ReturnType<typeof setInterval> | null;
	/** Whether this process owns ~/.claude-mux/queue.json and may write to it. */
	persist: boolean;
}

const GLOBAL_KEY = '__claude_mux_message_queue__';

/** Overridable so tests never touch the real ~/.claude-mux/queue.json. */
const QUEUE_PATH = process.env.CLAUDE_MUX_QUEUE_PATH ?? join(CLAUDE_MUX_DIR, 'queue.json');

interface PersistedQueueFile {
	v: number;
	owner_pid: number;
	queues: Record<string, QueuedMessage[]>;
}

function isPidAlive(pid: number): boolean {
	if (!pid || pid === process.pid) return pid === process.pid;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Read the persisted queue and decide whether this process may own it.
 *
 * Ownership is the pid recorded in the file: if that process is still running
 * and is not us, another server is already draining those messages, so we start
 * empty and never write — two servers pasting the same queued text into one
 * pane is worse than losing the restore.
 */
function loadPersisted(): { queues: Map<string, QueuedMessage[]>; persist: boolean } {
	const empty = new Map<string, QueuedMessage[]>();
	if (!existsSync(QUEUE_PATH)) return { queues: empty, persist: true };
	try {
		const file = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8')) as PersistedQueueFile;
		if (file.owner_pid && file.owner_pid !== process.pid && isPidAlive(file.owner_pid)) {
			console.warn(
				`[queue] ${QUEUE_PATH} is owned by live pid ${file.owner_pid}; running without persistence`
			);
			return { queues: empty, persist: false };
		}
		const now = Date.now();
		const queues = new Map<string, QueuedMessage[]>();
		for (const [target, messages] of Object.entries(file.queues ?? {})) {
			const fresh = (messages ?? [])
				.filter((m) => m && typeof m.text === 'string' && now - (m.queuedAt ?? 0) < QUEUE_TTL_MS)
				.map((m) => ({ ...m, kind: m.kind === 'control' ? 'control' : ('user' as QueuedMessageKind) }));
			if (fresh.length > 0) queues.set(target, fresh);
		}
		if (queues.size > 0) {
			console.log(`[queue] Restored ${queues.size} queue(s) from ${QUEUE_PATH}`);
		}
		return { queues, persist: true };
	} catch (err) {
		console.error('[queue] Failed to read persisted queue:', err);
		return { queues: empty, persist: true };
	}
}

/** Mirror the in-memory queues to disk. No-op when another server owns the file. */
function persistQueues(): void {
	if (!globalState.persist) return;
	try {
		const queues: Record<string, QueuedMessage[]> = {};
		for (const [target, queue] of globalState.queues) {
			if (queue.length > 0) queues[target] = queue;
		}
		const file: PersistedQueueFile = { v: 1, owner_pid: process.pid, queues };
		writeFileAtomic(QUEUE_PATH, JSON.stringify(file, null, 2));
	} catch (err) {
		console.error('[queue] Failed to persist queue:', err);
	}
}

function getGlobalState(): QueueGlobalState {
	const g = globalThis as Record<string, unknown>;
	if (!g[GLOBAL_KEY]) {
		const restored = loadPersisted();
		g[GLOBAL_KEY] = {
			queues: restored.queues,
			pendingDrain: new Map<string, number>(),
			recentlySent: new Map<string, number>(),
			missingSince: new Map<string, number>(),
			drainTimer: null,
			persist: restored.persist
		};
	}
	const state = g[GLOBAL_KEY] as Partial<QueueGlobalState>;
	// Backfill fields added after an older module instance created the state (dev HMR)
	state.recentlySent ??= new Map<string, number>();
	state.missingSince ??= new Map<string, number>();
	state.drainTimer ??= null;
	state.persist ??= true;
	return state as QueueGlobalState;
}

const globalState = getGlobalState();
const { queues, pendingDrain, recentlySent, missingSince } = globalState;

// ============================================================================
// Queue operations
// ============================================================================

export function enqueue(target: string, text: string, kind: QueuedMessageKind = 'user'): QueuedMessage[] {
	if (!queues.has(target)) {
		queues.set(target, []);
	}
	const queue = queues.get(target)!;
	queue.push({ text, queuedAt: Date.now(), kind });
	missingSince.delete(target);
	persistQueues();
	ensureDrainLoop();
	return queue;
}

export function dequeue(target: string): QueuedMessage | undefined {
	const queue = queues.get(target);
	if (!queue || queue.length === 0) return undefined;
	const message = queue.shift();
	if (queue.length === 0) queues.delete(target);
	persistQueues();
	return message;
}

export function getQueue(target: string): QueuedMessage[] {
	return queues.get(target) ?? [];
}

export function removeFromQueue(target: string, index: number): QueuedMessage[] {
	const queue = queues.get(target);
	if (!queue || index < 0 || index >= queue.length) return queue ?? [];
	queue.splice(index, 1);
	if (queue.length === 0) queues.delete(target);
	persistQueues();
	return queue ?? [];
}

export function reorderQueue(target: string, fromIndex: number, toIndex: number): QueuedMessage[] {
	const queue = queues.get(target);
	if (!queue) return [];
	if (fromIndex < 0 || fromIndex >= queue.length) return queue;
	if (toIndex < 0 || toIndex >= queue.length) return queue;
	const [item] = queue.splice(fromIndex, 1);
	queue.splice(toIndex, 0, item);
	persistQueues();
	return queue;
}

export function clearQueue(target: string): void {
	queues.delete(target);
	pendingDrain.delete(target);
	missingSince.delete(target);
	persistQueues();
}

/** Returns queue counts for all targets that have queued messages */
export function getQueueCounts(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const [target, queue] of queues) {
		if (queue.length > 0) {
			counts.set(target, queue.length);
		}
	}
	return counts;
}

export interface QueueSummary {
	count: number;
	/** The message that goes out next — what the UI should name. */
	head: QueuedMessage;
}

/**
 * Per-target count plus the message at the front, so the dashboard can say what
 * it is waiting on instead of showing a bare number.
 */
export function getQueueSummaries(): Map<string, QueueSummary> {
	const summaries = new Map<string, QueueSummary>();
	for (const [target, queue] of queues) {
		if (queue.length > 0) {
			summaries.set(target, { count: queue.length, head: queue[0] });
		}
	}
	return summaries;
}

// ============================================================================
// Auto-drain logic
// ============================================================================

/**
 * Forget queues that can no longer be delivered: messages older than the TTL,
 * and queues whose tmux target no longer belongs to any session. Without this a
 * queue aimed at a closed pane keeps the drain loop spinning forever.
 */
function pruneQueues(knownTargets: Set<string>, now: number): void {
	for (const [target, queue] of queues) {
		const fresh = queue.filter((m) => now - m.queuedAt < QUEUE_TTL_MS);
		if (fresh.length !== queue.length) {
			console.warn(
				`[queue] Dropped ${queue.length - fresh.length} message(s) for ${target}: older than ${QUEUE_TTL_MS}ms`
			);
			if (fresh.length === 0) queues.delete(target);
			else queues.set(target, fresh);
			persistQueues();
		}
		if (!queues.has(target)) {
			pendingDrain.delete(target);
			missingSince.delete(target);
			continue;
		}

		if (knownTargets.has(target)) {
			missingSince.delete(target);
			continue;
		}
		// The session file is gone (pane closed, session ended). Give it a grace
		// period — a session list read can come back short mid-write.
		const since = missingSince.get(target) ?? now;
		missingSince.set(target, since);
		if (now - since >= ORPHAN_GRACE_MS) {
			console.warn(`[queue] Dropped ${queues.get(target)!.length} message(s) for ${target}: session gone`);
			queues.delete(target);
			pendingDrain.delete(target);
			missingSince.delete(target);
			persistQueues();
		}
	}
}

/**
 * Drain queued messages for sessions sitting idle.
 * Called every ~500ms from the sessions WS manager refresh loop.
 *
 * Logic: while session is idle and has a queue, arm a 1s timer; if still idle
 * when it elapses, dequeue and send the front message. Leaving idle cancels
 * the timer. The 1s grace lets Claude settle after finishing a task and
 * covers the case where a message is enqueued while already idle.
 */
export function drainQueues(sessions: SessionLike[]): void {
	const now = Date.now();

	const knownTargets = new Set<string>();
	for (const session of sessions) {
		if (session.tmux_target) knownTargets.add(session.tmux_target);
	}
	pruneQueues(knownTargets, now);

	for (const session of sessions) {
		if (!session.tmux_target) continue;
		const target = session.tmux_target;

		const queue = queues.get(target);
		if (!queue || queue.length === 0) {
			pendingDrain.delete(target);
			continue;
		}

		if (session.state !== 'idle') {
			// Session picked up work (hook flipped state) — clear send guard
			pendingDrain.delete(target);
			recentlySent.delete(target);
			continue;
		}

		// After an auto-send, wait for the session to leave idle (UserPromptSubmit
		// hook) before sending the next message, so two queued messages don't get
		// pasted into the same prompt. Falls back after 10s in case the hook never fires.
		const sentAt = recentlySent.get(target);
		if (sentAt !== undefined) {
			if (now - sentAt < RESEND_FALLBACK_MS) continue;
			recentlySent.delete(target);
		}

		const pendingTime = pendingDrain.get(target);
		if (pendingTime === undefined) {
			pendingDrain.set(target, now);
			continue;
		}
		if (now - pendingTime < IDLE_GRACE_MS) continue;

		pendingDrain.delete(target);
		const message = dequeue(target);
		if (!message) continue;
		try {
			sendTextToPane(target, message.text);
			recentlySent.set(target, now);
			console.log(`[queue] Auto-sent queued message to ${target}`);
		} catch (err) {
			// tmux refused the paste — usually the pane is gone. Retry a couple of
			// times, then drop it: an undeliverable message must not keep the drain
			// loop, and its error log, running forever.
			const attempts = (message.attempts ?? 0) + 1;
			if (attempts >= MAX_SEND_ATTEMPTS) {
				console.error(
					`[queue] Giving up on message for ${target} after ${attempts} attempts:`,
					err
				);
				continue;
			}
			console.error(`[queue] Failed to send queued message to ${target} (attempt ${attempts}):`, err);
			if (!queues.has(target)) queues.set(target, []);
			queues.get(target)!.unshift({ ...message, attempts });
			persistQueues();
		}
	}
}

/**
 * Server-owned drain loop. Runs while any queue is non-empty, independent of
 * whether a dashboard client is connected (the WS refresh loop only runs with
 * clients, which previously left queues stuck once the phone closed the app).
 * State comes straight from the session JSON files written by hooks.
 */
export function ensureDrainLoop(): void {
	if (globalState.drainTimer) return;
	globalState.drainTimer = setInterval(() => {
		if (getQueueCounts().size === 0) {
			if (globalState.drainTimer) clearInterval(globalState.drainTimer);
			globalState.drainTimer = null;
			return;
		}
		try {
			drainQueues(getAllSessions());
		} catch (err) {
			console.error('[queue] drain loop error:', err);
		}
	}, DRAIN_INTERVAL_MS);
	// Don't keep the process alive just for this timer
	(globalState.drainTimer as { unref?: () => void }).unref?.();
}

// Resume draining if queues survived a module reload (dev HMR keeps globalThis)
// or a server restart (the persisted file above).
if (getQueueCounts().size > 0) ensureDrainLoop();
