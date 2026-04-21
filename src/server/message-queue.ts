/**
 * In-memory message queue for sessions.
 * Messages are queued per tmux target and auto-sent when the session goes idle.
 */

import { execFileSync, execSync } from 'child_process';

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
	previousStates: Map<string, string>;
	pendingDrain: Map<string, number>;
}

const GLOBAL_KEY = '__claude_mux_message_queue__';

function getGlobalState(): QueueGlobalState {
	const g = globalThis as Record<string, unknown>;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = {
			queues: new Map<string, QueuedMessage[]>(),
			previousStates: new Map<string, string>(),
			pendingDrain: new Map<string, number>()
		};
	}
	return g[GLOBAL_KEY] as QueueGlobalState;
}

const { queues, previousStates, pendingDrain } = getGlobalState();

// ============================================================================
// Queue operations
// ============================================================================

export function enqueue(target: string, text: string): QueuedMessage[] {
	if (!queues.has(target)) {
		queues.set(target, []);
	}
	const queue = queues.get(target)!;
	queue.push({ text, queuedAt: Date.now() });
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
 * Check sessions for idle transitions and drain queued messages.
 * Called every ~500ms from the sessions WS manager refresh loop.
 *
 * Logic:
 * 1. For each session, compare current state to previous state
 * 2. On transition TO idle: set a pending drain timestamp (1s delay)
 * 3. If session leaves idle before 1s: cancel pending drain
 * 4. If 1s has elapsed while still idle: dequeue and send front message
 */
export function drainQueues(sessions: SessionLike[]): void {
	const now = Date.now();

	for (const session of sessions) {
		if (!session.tmux_target) continue;
		const target = session.tmux_target;
		const currentState = session.state;
		const prevState = previousStates.get(target);

		// Update previous state
		previousStates.set(target, currentState);

		// Only care about sessions with queued messages
		const queue = queues.get(target);
		if (!queue || queue.length === 0) {
			pendingDrain.delete(target);
			continue;
		}

		if (currentState === 'idle') {
			if (prevState && prevState !== 'idle') {
				// Just transitioned to idle — start the 1s delay
				pendingDrain.set(target, now);
			} else if (pendingDrain.has(target)) {
				// Already pending — check if 1s has elapsed
				const pendingTime = pendingDrain.get(target)!;
				if (now - pendingTime >= 1000) {
					pendingDrain.delete(target);
					const message = dequeue(target);
					if (message) {
						try {
							sendTextToPane(target, message.text);
							console.log(`[queue] Auto-sent queued message to ${target}`);
						} catch (err) {
							console.error(`[queue] Failed to send queued message to ${target}:`, err);
							// Re-queue at front on failure
							if (!queues.has(target)) queues.set(target, []);
							queues.get(target)!.unshift(message);
						}
					}
				}
			}
			// If prevState was already idle and no pending drain, do nothing
			// (message was already sent or there was no transition)
		} else {
			// Not idle — cancel any pending drain
			pendingDrain.delete(target);
		}
	}
}
