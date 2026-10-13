import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const queueDir = mkdtempSync(join(tmpdir(), 'claude-mux-delivery-'));
process.env.CLAUDE_MUX_QUEUE_PATH = join(queueDir, 'queue.json');

/** Every text loaded into the tmux paste buffer, in order. */
const pastes: string[] = [];

/** What the pane reports when the drain asks whether it can take a message. */
let hold: 'working' | 'queued' | 'typed' | null = null;
/** Keys sent to the pane outside a paste. */
const keys: string[] = [];

vi.mock('child_process', () => ({
	execSync: vi.fn((_cmd: string, opts: { input?: string }) => {
		if (opts?.input !== undefined) pastes.push(opts.input);
	}),
	execFileSync: vi.fn((_cmd: string, args: string[]) => {
		if (args[0] === 'capture-pane') return 'pane';
		if (args[0] === 'send-keys') keys.push(args.at(-1)!);
	})
}));

vi.mock('../../src/tmux/pane.js', () => ({
	capturePaneContentAsync: vi.fn(async () => 'pane'),
	readPromptBox: vi.fn(() => null),
	readPaneHold: vi.fn(() => hold)
}));

const { enqueue, getQueue, clearQueue, drainQueues, editQueueItem, getDeliveries, promoteToSteer } =
	await import('../../src/server/message-queue.js');

/**
 * A pane of its own per test: the drain remembers a pane it just sent to and
 * holds the next message until the session leaves idle.
 */
let TARGET = '';
let pane = 0;

/** Two drain ticks a grace period apart: the first arms the timer, the second sends. */
function drainOnce() {
	const idle = [{ tmux_target: TARGET, state: 'idle' }];
	drainQueues(idle);
	vi.setSystemTime(Date.now() + 1100);
	drainQueues(idle);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	pastes.length = 0;
	keys.length = 0;
	hold = null;
	TARGET = `delivery-session:1.${++pane}`;
});

afterEach(() => {
	clearQueue(TARGET);
	vi.useRealTimers();
});

afterAll(() => rmSync(queueDir, { recursive: true, force: true }));

describe('queue delivery', () => {
	it('keeps attachments apart from the text and folds them in on delivery', () => {
		enqueue(TARGET, 'look at this', 'user', ['/tmp/a.png']);
		expect(getQueue(TARGET)[0]).toMatchObject({ text: 'look at this', attachments: ['/tmp/a.png'] });

		drainOnce();
		expect(pastes).toEqual(['@/tmp/a.png look at this']);
	});

	it('keeps the attachments when the text is edited', () => {
		const [item] = enqueue(TARGET, 'first draft', 'user', ['/tmp/a.png']);
		editQueueItem(TARGET, item.id, 'second draft');
		drainOnce();
		expect(pastes).toEqual(['@/tmp/a.png second draft']);
	});

	it('records what the drain sent, as a queue delivery', () => {
		enqueue(TARGET, 'next task');
		drainOnce();
		expect(getDeliveries(TARGET)).toEqual([{ text: 'next task', via: 'queue', at: Date.now() }]);
	});

	it('records a promoted item as a steer', async () => {
		const [item] = enqueue(TARGET, 'read this now');
		const result = promoteToSteer(TARGET, item.id, true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toBe('sent');
		expect(getDeliveries(TARGET).at(-1)).toMatchObject({ text: 'read this now', via: 'steer' });
	});
});

describe('a pane the hooks call idle', () => {
	const idle = () => [{ tmux_target: TARGET, state: 'idle' }];
	/** Drain ticks across a stretch of time, a second apart. */
	function tick(seconds: number) {
		for (let i = 0; i < seconds; i++) {
			vi.setSystemTime(Date.now() + 1000);
			drainQueues(idle());
		}
	}

	it('is not sent to while it compacts, and gets the message once it stops', () => {
		enqueue(TARGET, 'after the compaction');
		hold = 'working';
		drainOnce();
		tick(30);
		expect(pastes).toEqual([]);

		hold = null;
		tick(2);
		expect(pastes).toEqual(['after the compaction']);
	});

	it('gets one message at a time when Claude Code parks the first instead of running it', () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		enqueue(TARGET, 'third');
		drainOnce();
		expect(pastes).toEqual(['first']);

		// No prompt hook answers, because the pane was busy after all and Claude
		// Code queued the message. The ten-second fallback must not send the rest.
		hold = 'queued';
		tick(60);
		expect(pastes).toEqual(['first']);
		expect(getQueue(TARGET).map((m) => m.text)).toEqual(['second', 'third']);
	});

	it('presses Enter again when its own message is still in the box, and pastes nothing over it', () => {
		enqueue(TARGET, 'first');
		enqueue(TARGET, 'second');
		drainOnce();
		keys.length = 0;

		hold = 'typed';
		tick(12);
		expect(keys).toEqual(['Enter']);
		expect(pastes).toEqual(['first']);
	});

	it('leaves a draft someone typed in the pane alone', () => {
		enqueue(TARGET, 'queued behind a draft');
		hold = 'typed';
		drainOnce();
		tick(15);
		expect(pastes).toEqual([]);
		expect(keys).toEqual([]);
	});
});

describe('queue edits by id', () => {
	it('removes and moves the item named, whatever its position', async () => {
		const { removeQueueItem, moveQueueItem } = await import('../../src/server/message-queue.js');
		const [a] = enqueue(TARGET, 'A');
		const b = enqueue(TARGET, 'B')[1];
		const c = enqueue(TARGET, 'C')[2];
		moveQueueItem(TARGET, c.id, 0);
		expect(getQueue(TARGET).map((m) => m.text)).toEqual(['C', 'A', 'B']);
		removeQueueItem(TARGET, b.id);
		expect(getQueue(TARGET).map((m) => m.text)).toEqual(['C', 'A']);
		removeQueueItem(TARGET, 'gone');
		expect(getQueue(TARGET).map((m) => m.id)).toEqual([c.id, a.id]);
	});
});
