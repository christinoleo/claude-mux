/**
 * In-memory message queue for sessions.
 * Messages are queued per tmux target and auto-sent when the session goes idle.
 */

import { execFileSync, execSync } from 'child_process';
import { getAllSessions } from '../db/index.js';

// ============================================================================
// Types
// ============================================================================

export interface QueuedMessage {
	text: string;
	queuedAt: number;
}

interface SessionLike {
	tmux_target: string | null;
	state: string;
}

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
	drainTimer: ReturnType<typeof setInterval> | null;
}

const GLOBAL_KEY = '__claude_mux_message_queue__';

function getGlobalState(): QueueGlobalState {
	const g = globalThis as Record<string, unknown>;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = {
			queues: new Map<string, QueuedMessage[]>(),
			pendingDrain: new Map<string, number>(),
			recentlySent: new Map<string, number>(),
			drainTimer: null
		};
	}
	const state = g[GLOBAL_KEY] as Partial<QueueGlobalState>;
	// Backfill fields added after an older module instance created the state (dev HMR)
	state.recentlySent ??= new Map<string, number>();
	state.drainTimer ??= null;
	return state as QueueGlobalState;
}

const globalState = getGlobalState();
const { queues, pendingDrain, recentlySent } = globalState;

// ============================================================================
// Queue operations
// ============================================================================

export function enqueue(target: string, text: string): QueuedMessage[] {
	if (!queues.has(target)) {
		queues.set(target, []);
	}
	const queue = queues.get(target)!;
	queue.push({ text, queuedAt: Date.now() });
	ensureDrainLoop();
	return queue;
}

export function dequeue(target: string): QueuedMessage | undefined {
	const queue = queues.get(target);
	if (!queue || queue.length === 0) return undefined;
	return queue.shift();
}

export function getQueue(target: string): QueuedMessage[] {
	return queues.get(target) ?? [];
}

export function removeFromQueue(target: string, index: number): QueuedMessage[] {
	const queue = queues.get(target);
	if (!queue || index < 0 || index >= queue.length) return queue ?? [];
	queue.splice(index, 1);
	if (queue.length === 0) queues.delete(target);
	return queue ?? [];
}

export function reorderQueue(target: string, fromIndex: number, toIndex: number): QueuedMessage[] {
	const queue = queues.get(target);
	if (!queue) return [];
	if (fromIndex < 0 || fromIndex >= queue.length) return queue;
	if (toIndex < 0 || toIndex >= queue.length) return queue;
	const [item] = queue.splice(fromIndex, 1);
	queue.splice(toIndex, 0, item);
	return queue;
}

export function clearQueue(target: string): void {
	queues.delete(target);
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

// ============================================================================
// Auto-drain logic
// ============================================================================

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
			console.error(`[queue] Failed to send queued message to ${target}:`, err);
			if (!queues.has(target)) queues.set(target, []);
			queues.get(target)!.unshift(message);
		}
	}
}

const IDLE_GRACE_MS = 1000;
const RESEND_FALLBACK_MS = 10_000;
const DRAIN_INTERVAL_MS = 500;

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
if (getQueueCounts().size > 0) ensureDrainLoop();
