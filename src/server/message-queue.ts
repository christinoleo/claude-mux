/**
 * Message queue for sessions.
 * Messages are queued per tmux target and auto-sent when the session goes idle.
 *
 * The queue is kept in memory and mirrored to ~/.claude-mux/queue.json, so a
 * server restart does not silently swallow messages that were waiting for a
 * busy pane. Only one server owns the file at a time (see the ownership lock
 * below): a second instance, such as the dev server running alongside the
 * systemd one, keeps its own in-memory queue and leaves the file alone, so
 * neither restores — and then re-sends — what the other is already holding.
 */

import { execFileSync, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAllSessions } from '../db/index.js';
import { CLAUDE_MUX_DIR } from '../utils/paths.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { isPidAlive } from '../utils/pid.js';
import { capturePaneContentAsync, readPromptBox } from '../tmux/pane.js';
import { composePromptWithAttachments } from './attachments.js';
import type { DeliveryInfo, QueuedMessageInfo } from '../types/ws-messages.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Who put the message in the queue. `user` is something a human typed and is
 * waiting to see delivered; `control` is claude-mux talking to the agent on its
 * own behalf (today: mirroring a dashboard rename as `/rename`). The UI needs
 * the difference so it can stop reporting its own bookkeeping as your backlog.
 */
export type QueuedMessageKind = QueuedMessageInfo['kind'];

export interface QueuedMessage extends QueuedMessageInfo {
	/** Failed send attempts, so a message aimed at a dead pane gives up. */
	attempts?: number;
}

/** What the pane is given for a queued message: its attachments folded into the text. */
export function promptOf(message: QueuedMessageInfo): string {
	return composePromptWithAttachments(message.text, message.attachments ?? []);
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

/** How long Claude Code gets to take a pasted line before the box is read. */
const SUBMIT_SETTLE_MS = 600;

/**
 * Whether Claude Code took the line just sent. A message it accepted has left
 * the box: either the turn started, or, while busy, it went to Claude Code's
 * own queue and the box shows the hint for that. Text still sitting there
 * typed means the Enter was lost, which happens when the paste and the key
 * land inside the same input burst; one more Enter is sent, and the box read
 * again. Resolves false when the text is still there after that.
 */
export async function confirmSubmitted(target: string): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS));
		const raw = await capturePaneContentAsync(target, true);
		const box = raw === null ? null : readPromptBox(raw);
		if (!box || box.kind !== 'typed' || !box.text.trim()) return true;
		if (attempt === 0) execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
	}
	return false;
}

/**
 * Claude Code's "send now" chord. While a turn runs, it hands every message
 * waiting in Claude Code's own queue to the model at once, moving a running
 * foreground command to the background rather than killing it. While idle, it
 * submits whatever sits typed in the box.
 */
export function sendNowInPane(target: string): void {
	execFileSync('tmux', ['send-keys', '-t', target, 'C-x', 'C-s'], { stdio: 'ignore' });
}

/**
 * Deliver text into the running turn now. A busy pane takes the pasted line
 * into Claude Code's own queue, and the chord then pushes that queue into the
 * turn; any other pane just takes it as a normal send. Resolves false when
 * Claude Code left the text in its box, as `confirmSubmitted` does.
 */
export async function steerIntoPane(target: string, text: string, busy: boolean): Promise<boolean> {
	sendTextToPane(target, text);
	if (!(await confirmSubmitted(target))) return false;
	if (busy) sendNowInPane(target);
	recordDelivery(target, text, 'steer');
	return true;
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
	/** target → what the queue and steer handed the pane lately, newest last */
	deliveries: Map<string, DeliveryInfo[]>;
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
		const queues = new Map<string, QueuedMessage[]>();
		for (const [target, messages] of Object.entries(file.queues ?? {})) {
			// Expiry belongs to pruneQueues, which runs on the first drain tick.
			const restored = (messages ?? [])
				.filter((m) => m && typeof m.text === 'string')
				.map((m) => ({
					...m,
					// Files written before items carried an id get one on the way in.
					id: typeof m.id === 'string' ? m.id : randomUUID(),
					kind: m.kind === 'control' ? 'control' : ('user' as QueuedMessageKind)
				}));
			if (restored.length > 0) queues.set(target, restored);
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
			deliveries: new Map<string, DeliveryInfo[]>(),
			drainTimer: null,
			persist: restored.persist
		};
	}
	const state = g[GLOBAL_KEY] as Partial<QueueGlobalState>;
	// Backfill fields added after an older module instance created the state (dev HMR)
	state.recentlySent ??= new Map<string, number>();
	state.missingSince ??= new Map<string, number>();
	state.deliveries ??= new Map<string, DeliveryInfo[]>();
	state.drainTimer ??= null;
	state.persist ??= true;
	return state as QueueGlobalState;
}

const globalState = getGlobalState();
const { queues, pendingDrain, recentlySent, missingSince, deliveries } = globalState;

// ============================================================================
// Delivery log
// ============================================================================

/** How many deliveries a pane remembers, and for how long. */
const DELIVERY_LOG_SIZE = 20;
const DELIVERY_LOG_TTL_MS = 60 * 60 * 1000;

/**
 * Remember that the queue or a steer handed this text to the pane, so the
 * transcript can label the user turn it becomes. In memory only: the label is
 * a courtesy, and a restart forgetting it costs nothing.
 */
export function recordDelivery(target: string, text: string, via: DeliveryInfo['via']): void {
	const now = Date.now();
	const log = (deliveries.get(target) ?? []).filter((d) => now - d.at < DELIVERY_LOG_TTL_MS);
	log.push({ text, via, at: now });
	deliveries.set(target, log.slice(-DELIVERY_LOG_SIZE));
}

export function getDeliveries(target: string): DeliveryInfo[] {
	return deliveries.get(target) ?? [];
}

// ============================================================================
// Queue operations
// ============================================================================

function queueFor(target: string): QueuedMessage[] {
	let queue = queues.get(target);
	if (!queue) queues.set(target, (queue = []));
	return queue;
}

export function enqueue(
	target: string,
	text: string,
	kind: QueuedMessageKind = 'user',
	attachments: string[] = []
): QueuedMessage[] {
	const queue = queueFor(target);
	const message: QueuedMessage = { id: randomUUID(), text, queuedAt: Date.now(), kind };
	if (attachments.length > 0) message.attachments = attachments;
	queue.push(message);
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

/**
 * Replace one item's text in place; its position and timestamp stay. The item
 * is named by id rather than position, because the drain may have sent the
 * head between the client's view of the queue and this call. False when it
 * has already left the queue.
 */
export function editQueueItem(target: string, id: string, text: string): boolean {
	const item = queues.get(target)?.find((m) => m.id === id);
	if (!item) return false;
	item.text = text;
	persistQueues();
	return true;
}

/**
 * How promoting a queued item went: `sent` into the turn, `missing` because it
 * had already left the queue, or `in-box` when Claude Code left the pasted
 * text sitting in its input box.
 */
export type PromoteResult = 'sent' | 'missing' | 'in-box';

/**
 * Take one item out of the queue and steer it into the pane. Taken out first,
 * so the drain loop cannot send it while the steer is in flight. It goes back
 * only when the paste itself failed: text Claude Code left in its box is
 * already in the pane, and queueing it again would deliver it twice.
 */
export async function promoteToSteer(target: string, id: string, busy: boolean): Promise<PromoteResult> {
	const queue = queues.get(target);
	const index = queue?.findIndex((m) => m.id === id) ?? -1;
	if (!queue || index === -1) return 'missing';
	const [message] = queue.splice(index, 1);
	if (queue.length === 0) queues.delete(target);
	persistQueues();
	try {
		return (await steerIntoPane(target, promptOf(message), busy)) ? 'sent' : 'in-box';
	} catch (err) {
		const restored = queueFor(target);
		restored.splice(Math.min(index, restored.length), 0, message);
		persistQueues();
		ensureDrainLoop();
		throw err;
	}
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

/** Whether anything at all is queued — the drain loop's own start/stop guard. */
export function hasQueuedMessages(): boolean {
	return queues.size > 0;
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
	let changed = false;
	const drop = (target: string) => {
		queues.delete(target);
		pendingDrain.delete(target);
		missingSince.delete(target);
		changed = true;
	};

	for (const [target, queue] of queues) {
		// Messages are appended in time order (and a retry goes back to the
		// front), so the head is the oldest: no scan unless it has expired.
		if (queue.length === 0 || now - queue[0].queuedAt >= QUEUE_TTL_MS) {
			const fresh = queue.filter((m) => now - m.queuedAt < QUEUE_TTL_MS);
			if (fresh.length < queue.length) {
				console.warn(
					`[queue] Dropped ${queue.length - fresh.length} message(s) for ${target}: older than ${QUEUE_TTL_MS}ms`
				);
			}
			if (fresh.length === 0) {
				drop(target);
				continue;
			}
			queues.set(target, fresh);
			changed = true;
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
			console.warn(`[queue] Dropped ${queue.length} message(s) for ${target}: session gone`);
			drop(target);
		}
	}

	if (changed) persistQueues();
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
		// Peek rather than dequeue: a message only leaves the queue once tmux has
		// taken it, so a failed send costs one attempt instead of a remove and a
		// re-insert (and two writes of the persisted file).
		const message = queue[0];
		try {
			const prompt = promptOf(message);
			sendTextToPane(target, prompt);
			dequeue(target);
			recordDelivery(target, prompt, 'queue');
			recentlySent.set(target, now);
			console.log(`[queue] Auto-sent queued message to ${target}`);
		} catch (err) {
			// tmux refused the paste — usually the pane is gone. Retry a couple of
			// times, then drop it: an undeliverable message must not keep the drain
			// loop, and its error log, running forever.
			message.attempts = (message.attempts ?? 0) + 1;
			if (message.attempts >= MAX_SEND_ATTEMPTS) {
				console.error(
					`[queue] Giving up on message for ${target} after ${message.attempts} attempts:`,
					err
				);
				dequeue(target);
				continue;
			}
			console.error(
				`[queue] Failed to send queued message to ${target} (attempt ${message.attempts}):`,
				err
			);
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
		if (!hasQueuedMessages()) {
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
if (hasQueuedMessages()) ensureDrainLoop();
