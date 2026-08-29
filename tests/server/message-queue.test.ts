import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const queueDir = mkdtempSync(join(tmpdir(), 'claude-mux-queue-'));
const queuePath = join(queueDir, 'queue.json');
process.env.CLAUDE_MUX_QUEUE_PATH = queuePath;

const { enqueue, getQueue, clearQueue, drainQueues, getQueueSummary } = await import(
	'../../src/server/message-queue.js'
);

const TARGET = 'test-session:1.1';

describe('message queue', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		clearQueue(TARGET);
	});

	afterEach(() => {
		clearQueue(TARGET);
		vi.useRealTimers();
	});

	it('defaults to a user message and keeps control messages tagged', () => {
		enqueue(TARGET, 'hello');
		enqueue(TARGET, '/rename thing', 'control');
		expect(getQueue(TARGET).map((m) => m.kind)).toEqual(['user', 'control']);
	});

	it('summarises the head message so the UI can name it', () => {
		enqueue(TARGET, '/rename thing', 'control');
		enqueue(TARGET, 'second');
		const summary = getQueueSummary(TARGET);
		expect(summary?.count).toBe(2);
		expect(summary?.head.text).toBe('/rename thing');
		expect(summary?.head.kind).toBe('control');
	});

	it('drops a queue whose session disappeared, after the grace period', () => {
		enqueue(TARGET, 'hello');
		// Session list momentarily missing the target: keep it.
		drainQueues([]);
		expect(getQueue(TARGET)).toHaveLength(1);

		vi.setSystemTime(Date.now() + 61_000);
		drainQueues([]);
		expect(getQueue(TARGET)).toHaveLength(0);
	});

	it('keeps the queue while the session is still listed', () => {
		enqueue(TARGET, 'hello');
		vi.setSystemTime(Date.now() + 10 * 60_000);
		drainQueues([{ tmux_target: TARGET, state: 'busy' }]);
		expect(getQueue(TARGET)).toHaveLength(1);
	});

	it('drops messages older than the TTL', () => {
		enqueue(TARGET, 'hello');
		vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
		drainQueues([{ tmux_target: TARGET, state: 'busy' }]);
		expect(getQueue(TARGET)).toHaveLength(0);
	});

	it('persists queued messages to disk', () => {
		enqueue(TARGET, 'survive a restart', 'control');
		expect(existsSync(queuePath)).toBe(true);
		const file = JSON.parse(readFileSync(queuePath, 'utf-8'));
		expect(file.owner_pid).toBe(process.pid);
		expect(file.queues[TARGET][0]).toMatchObject({ text: 'survive a restart', kind: 'control' });

		clearQueue(TARGET);
		const after = JSON.parse(readFileSync(queuePath, 'utf-8'));
		expect(after.queues[TARGET]).toBeUndefined();
	});
});

afterAll(() => {
	if (existsSync(queueDir)) rmSync(queueDir, { recursive: true, force: true });
});
