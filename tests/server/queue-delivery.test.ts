import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const queueDir = mkdtempSync(join(tmpdir(), 'claude-mux-delivery-'));
process.env.CLAUDE_MUX_QUEUE_PATH = join(queueDir, 'queue.json');

/** Every text loaded into the tmux paste buffer, in order. */
const pastes: string[] = [];

vi.mock('child_process', () => ({
	execSync: vi.fn((_cmd: string, opts: { input?: string }) => {
		if (opts?.input !== undefined) pastes.push(opts.input);
	}),
	execFileSync: vi.fn()
}));

vi.mock('../../src/tmux/pane.js', () => ({
	capturePaneContentAsync: vi.fn(async () => 'pane'),
	readPromptBox: vi.fn(() => null)
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
