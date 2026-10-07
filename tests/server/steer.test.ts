import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const queueDir = mkdtempSync(join(tmpdir(), 'claude-mux-steer-'));
process.env.CLAUDE_MUX_QUEUE_PATH = join(queueDir, 'queue.json');

/** Every tmux invocation, as its argument list. */
const tmuxCalls: string[][] = [];
/** What the next box reads return: typed text left in the box, or null for empty. */
let boxText: string | null = null;

vi.mock('child_process', () => ({
	execSync: vi.fn((cmd: string) => tmuxCalls.push(cmd.split(' ').slice(1))),
	execFileSync: vi.fn((_bin: string, args: string[]) => tmuxCalls.push(args))
}));

vi.mock('../../src/tmux/pane.js', () => ({
	capturePaneContentAsync: vi.fn(async () => 'pane'),
	readPromptBox: vi.fn(() => (boxText === null ? null : { kind: 'typed', text: boxText }))
}));

const { enqueue, getQueue, clearQueue, editQueueItem, promoteToSteer, steerIntoPane } =
	await import('../../src/server/message-queue.js');

const TARGET = 'steer-session:1.1';
const CHORD = ['send-keys', '-t', TARGET, 'C-x', 'C-s'];

/**
 * Run a steer with fake timers past its box-read settle delays. Bounded rather
 * than run-all: the queue's drain loop is an interval and would never end.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
	await vi.advanceTimersByTimeAsync(2000);
	return promise;
}

const pasted = () => tmuxCalls.some((c) => c[0] === 'paste-buffer');
const chorded = () => tmuxCalls.some((c) => c.join(' ') === CHORD.join(' '));

describe('steer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		tmuxCalls.length = 0;
		boxText = null;
		clearQueue(TARGET);
	});

	afterEach(() => {
		clearQueue(TARGET);
		vi.useRealTimers();
	});

	it('pastes into a busy pane, then sends the send-now chord', async () => {
		expect(await settle(steerIntoPane(TARGET, 'look at this', true))).toBe(true);
		expect(pasted()).toBe(true);
		const enter = tmuxCalls.findIndex((c) => c.join(' ') === `send-keys -t ${TARGET} Enter`);
		const chord = tmuxCalls.findIndex((c) => c.join(' ') === CHORD.join(' '));
		expect(enter).toBeGreaterThan(-1);
		expect(chord).toBeGreaterThan(enter);
	});

	it('is a normal send when the pane is not busy', async () => {
		expect(await settle(steerIntoPane(TARGET, 'hello', false))).toBe(true);
		expect(pasted()).toBe(true);
		expect(chorded()).toBe(false);
	});

	it('sends no chord when Claude Code left the text in its box', async () => {
		boxText = 'look at this';
		expect(await settle(steerIntoPane(TARGET, 'look at this', true))).toBe(false);
		expect(chorded()).toBe(false);
	});
});

describe('promote to steer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		tmuxCalls.length = 0;
		boxText = null;
		clearQueue(TARGET);
	});

	afterEach(() => {
		clearQueue(TARGET);
		vi.useRealTimers();
	});

	it('takes the item out of the queue and steers it', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		enqueue(TARGET, 'third');
		const { ok, queue } = await settle(promoteToSteer(TARGET, 1, true));
		expect(ok).toBe(true);
		expect(queue.map((m) => m.text)).toEqual(['first', 'third']);
		expect(chorded()).toBe(true);
	});

	it('puts the item back where it was when the pane does not take it', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		boxText = 'second';
		const { ok, queue } = await settle(promoteToSteer(TARGET, 1, true));
		expect(ok).toBe(false);
		expect(queue.map((m) => m.text)).toEqual(['first', 'second']);
	});

	it('refuses an index outside the queue without touching the pane', async () => {
		enqueue(TARGET, 'only');
		const { ok } = await settle(promoteToSteer(TARGET, 3, true));
		expect(ok).toBe(false);
		expect(tmuxCalls).toEqual([]);
		expect(getQueue(TARGET)).toHaveLength(1);
	});
});

describe('edit a queued item', () => {
	beforeEach(() => clearQueue(TARGET));

	it('replaces the text in place, keeping position, kind and time', () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, '/rename x', 'control');
		const before = getQueue(TARGET)[1];
		const queue = editQueueItem(TARGET, 1, '/rename y');
		expect(queue.map((m) => m.text)).toEqual(['first', '/rename y']);
		expect(queue[1]).toMatchObject({ kind: 'control', queuedAt: before.queuedAt });
	});

	it('ignores an index outside the queue', () => {
		enqueue(TARGET, 'first');
		expect(editQueueItem(TARGET, 5, 'nope').map((m) => m.text)).toEqual(['first']);
	});
});

afterAll(() => {
	if (existsSync(queueDir)) rmSync(queueDir, { recursive: true, force: true });
});
