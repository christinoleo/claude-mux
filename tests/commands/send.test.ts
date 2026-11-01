import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TARGET = 'cli-session:1.1';
let state = 'idle';
const writes: string[][] = [];

vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	execFileSync: vi.fn((_bin: string, args: string[]) => {
		writes.push(args);
	})
}));

vi.mock('../../src/commands/resolve-session.js', () => ({
	resolveSessionOrExit: () => ({ id: 'session-id', tmux_target: TARGET, state })
}));

vi.mock('../../src/tmux/pane.js', async (original) => ({
	...(await original<typeof import('../../src/tmux/pane.js')>()),
	capturePaneContentAsync: vi.fn(async () => '')
}));

const { createSendCommand } = await import('../../src/commands/send.js');

const run = (...args: string[]) => createSendCommand().parseAsync(args, { from: 'user' });

describe('claude-mux send', () => {
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		writes.length = 0;
		state = 'idle';
		stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
	});

	afterEach(() => vi.restoreAllMocks());

	it.each(['waiting', 'permission'])('refuses text while the hooks report %s', async (reported) => {
		state = reported;
		await expect(run(TARGET, 'please stop')).rejects.toThrow();
		expect(writes).toEqual([]);
		expect(String(stderr.mock.calls[0][0])).toContain('Answer the open dialog first');
	});

	it('still sends the keys that answer a dialog', async () => {
		state = 'permission';
		await run(TARGET, '--keys', 'Enter');
		expect(writes).toEqual([['send-keys', '-t', TARGET, 'Enter']]);
	});

	it('sends text to a pane with no dialog', async () => {
		await run(TARGET, 'hello');
		expect(writes.some((c) => c[0] === 'paste-buffer')).toBe(true);
		expect(writes.at(-1)).toEqual(['send-keys', '-t', TARGET, 'Enter']);
	});
});
