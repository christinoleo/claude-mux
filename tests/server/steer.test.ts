import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const queueDir = mkdtempSync(join(tmpdir(), 'claude-mux-steer-'));
process.env.CLAUDE_MUX_QUEUE_PATH = join(queueDir, 'queue.json');

/** Every tmux invocation, as its argument list. */
const tmuxCalls: string[][] = [];
/** What the box reads return: typed text left in the box, or null for empty. */
let boxText: string | null = null;
/** Reads to answer before falling back to `boxText`, one each, in order. */
let boxReads: (string | null)[] = [];
/** Make the paste itself fail, as tmux does for a pane that has gone. */
let failPaste = false;

vi.mock('child_process', () => ({
	execSync: vi.fn((cmd: string) => tmuxCalls.push(cmd.split(' ').slice(1))),
	execFileSync: vi.fn((_bin: string, args: string[]) => {
		if (failPaste && args[0] === 'paste-buffer') throw new Error('no such pane');
		tmuxCalls.push(args);
	})
}));

vi.mock('../../src/tmux/pane.js', () => ({
	capturePaneContentAsync: vi.fn(async () => 'pane'),
	readPromptBox: vi.fn(() => {
		const text = boxReads.length > 0 ? boxReads.shift()! : boxText;
		return text === null ? null : { kind: 'typed', text };
	})
}));

const { enqueue, dequeue, getQueue, clearQueue, editQueueItem, promoteToSteer, steerIntoPane } =
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
const callIndex = (args: string[]) => tmuxCalls.findIndex((c) => c.join(' ') === args.join(' '));
const chorded = () => callIndex(CHORD) > -1;

beforeEach(() => {
	vi.useFakeTimers();
	tmuxCalls.length = 0;
	boxText = null;
	boxReads = [];
	failPaste = false;
	clearQueue(TARGET);
});

afterEach(() => {
	clearQueue(TARGET);
	vi.useRealTimers();
});

describe('steer', () => {
	it('hands a busy pane the message and leaves Claude Code to read it in its own time', async () => {
		expect(await settle(steerIntoPane(TARGET, 'look at this', true))).toBe('taken');
		expect(pasted()).toBe(true);
		expect(callIndex(['send-keys', '-t', TARGET, 'Enter'])).toBeGreaterThan(-1);
		expect(chorded()).toBe(false);
	});

	it('with now, pastes into a busy pane and then sends the send-now chord', async () => {
		expect(await settle(steerIntoPane(TARGET, 'look at this', true, { mode: 'now' }))).toBe('taken');
		expect(pasted()).toBe(true);
		const enter = callIndex(['send-keys', '-t', TARGET, 'Enter']);
		const chord = callIndex(CHORD);
		expect(enter).toBeGreaterThan(-1);
		expect(chord).toBeGreaterThan(enter);
	});

	it('is a normal send when the pane is not busy', async () => {
		expect(await settle(steerIntoPane(TARGET, 'hello', false, { mode: 'now' }))).toBe('taken');
		expect(pasted()).toBe(true);
		expect(chorded()).toBe(false);
	});

	it('sends no chord when Claude Code left the text in its box', async () => {
		// Empty when pasted into, then the text stays put through the retry Enter.
		boxReads = [null];
		boxText = 'look at this';
		expect(await settle(steerIntoPane(TARGET, 'look at this', true, { mode: 'now' }))).toBe('in-box');
		expect(pasted()).toBe(true);
		expect(chorded()).toBe(false);
	});

	it('submits the copy an earlier try left in the box rather than pasting a second one', async () => {
		// The box wraps and indents what it holds.
		boxReads = ['look at\n  this', null];
		expect(await settle(steerIntoPane(TARGET, 'look at this', true))).toBe('taken');
		expect(pasted()).toBe(false);
		expect(callIndex(['send-keys', '-t', TARGET, 'Enter'])).toBeGreaterThan(-1);
	});

	it('leaves the pane alone when something else is typed in its box', async () => {
		boxText = 'a draft of my own';
		expect(await settle(steerIntoPane(TARGET, 'look at this', true, { mode: 'now' }))).toBe('occupied');
		expect(tmuxCalls).toEqual([]);
	});
});

const texts = () => getQueue(TARGET).map((m) => m.text);
const idOf = (text: string) => getQueue(TARGET).find((m) => m.text === text)!.id;

describe('promote to steer', () => {
	it('takes the item out of the queue and steers it', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		enqueue(TARGET, 'third');
		expect(await settle(promoteToSteer(TARGET, idOf('second'), true))).toBe('sent');
		expect(texts()).toEqual(['first', 'third']);
		expect(pasted()).toBe(true);
		expect(chorded()).toBe(false);
	});

	it('with now, also makes Claude Code read it at once', async () => {
		enqueue(TARGET, 'first');
		expect(await settle(promoteToSteer(TARGET, idOf('first'), true, 'now'))).toBe('sent');
		expect(texts()).toEqual([]);
		expect(chorded()).toBe(true);
	});

	it('steers the item it was asked for after the head has drained', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		enqueue(TARGET, 'third');
		const id = idOf('second');
		dequeue(TARGET);
		expect(await settle(promoteToSteer(TARGET, id, true))).toBe('sent');
		expect(texts()).toEqual(['third']);
	});

	it('does not queue text again that Claude Code left in its box', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		boxReads = [null];
		boxText = 'second';
		expect(await settle(promoteToSteer(TARGET, idOf('second'), true))).toBe('in-box');
		expect(texts()).toEqual(['first']);
	});

	it('puts the item back where it was when something else is typed in the box', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		boxText = 'a draft of my own';
		expect(await settle(promoteToSteer(TARGET, idOf('first'), true))).toBe('occupied');
		expect(texts()).toEqual(['first', 'second']);
		expect(pasted()).toBe(false);
	});

	it('puts the item back where it was when the paste fails', async () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		failPaste = true;
		const steer = promoteToSteer(TARGET, idOf('first'), true);
		// Handled before the timers run, or the rejection lands unhandled.
		const rejected = expect(steer).rejects.toThrow();
		await settle(steer).catch(() => {});
		await rejected;
		expect(texts()).toEqual(['first', 'second']);
	});

	it('reports an item already gone without touching the pane', async () => {
		enqueue(TARGET, 'only');
		expect(await settle(promoteToSteer(TARGET, 'gone', true))).toBe('missing');
		expect(tmuxCalls).toEqual([]);
		expect(texts()).toEqual(['only']);
	});
});

describe('edit a queued item', () => {
	it('replaces the text in place, keeping position, kind and time', () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, '/rename x', 'control');
		const before = getQueue(TARGET)[1];
		expect(editQueueItem(TARGET, before.id, '/rename y')).toBe(true);
		expect(texts()).toEqual(['first', '/rename y']);
		expect(getQueue(TARGET)[1]).toMatchObject({ kind: 'control', queuedAt: before.queuedAt });
	});

	it('edits the item it was asked for after the head has drained', () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		const id = idOf('second');
		dequeue(TARGET);
		expect(editQueueItem(TARGET, id, 'second, edited')).toBe(true);
		expect(texts()).toEqual(['second, edited']);
	});

	it('reports an item already gone', () => {
		enqueue(TARGET, 'first');
		expect(editQueueItem(TARGET, 'gone', 'nope')).toBe(false);
		expect(texts()).toEqual(['first']);
	});
});

afterAll(() => {
	if (existsSync(queueDir)) rmSync(queueDir, { recursive: true, force: true });
});
