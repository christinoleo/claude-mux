import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const queueDir = mkdtempSync(join(tmpdir(), 'claude-mux-dialog-'));
process.env.CLAUDE_MUX_QUEUE_PATH = join(queueDir, 'queue.json');

const TARGET = 'dialog-session:1.1';

/** What the hooks last wrote for the session. */
let state = 'idle';
/** The session files, when a test wants several; otherwise one in `state`. */
let sessions: { id: string; tmux_target: string; state: string; last_update: number }[] | null = null;
/** What a capture of the pane returns. */
let screen = '';
/** Every tmux command that writes to the pane. */
const writes: string[][] = [];
const pasted = () => writes.some((c) => c[0] === 'paste-buffer');
const enters = () => writes.filter((c) => c.at(-1) === 'Enter').length;

vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	execSync: vi.fn(),
	execFileSync: vi.fn((_bin: string, args: string[]) => {
		if (args[0] === 'capture-pane') return screen;
		writes.push(args);
	})
}));

vi.mock('../../src/db/index.js', () => ({
	getAllSessions: vi.fn(() => sessions ?? [{ id: 'session-id', tmux_target: TARGET, state, last_update: 0 }])
}));

// The real pane readers: whether a dialog shows is what is under test.
vi.mock('../../src/tmux/pane.js', async (original) => ({
	...(await original<typeof import('../../src/tmux/pane.js')>()),
	capturePaneContentAsync: vi.fn(async () => screen)
}));

vi.mock('../../src/transcript/tailer.js', () => ({ resolveTranscriptPath: vi.fn(() => null) }));

vi.mock('@sveltejs/kit', () => ({
	json: (body: unknown, init?: { status?: number }) =>
		new Response(JSON.stringify(body), { status: init?.status ?? 200 })
}));
vi.mock('$lib/server/ws-managers.js', () => ({ broadcastSessions: vi.fn() }));

const { enqueue, getQueue, clearQueue, drainQueues, paneHasDialog, promoteToSteer, submitToPane, steerIntoPane } =
	await import('../../src/server/message-queue.js');
const send = await import('../../web/src/routes/api/sessions/[id]/send/+server.js');
const steer = await import('../../web/src/routes/api/sessions/[id]/steer/+server.js');

/** A local command's dialog: the hooks stay idle, and it names its own keys. */
const LOCAL_DIALOG = [
	' Select model',
	' ❯ 1. Default',
	'   2. Sonnet',
	'',
	' Enter to confirm · Esc to exit'
].join('\n');

/** An empty box and nothing else, a pane free to take a message. */
const FREE = ['─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n');

/** A route's POST, as SvelteKit calls it. */
function post(route: typeof send | typeof steer, body: unknown) {
	return route.POST({
		params: { id: encodeURIComponent(TARGET) },
		request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
	} as never) as Promise<Response>;
}

/** Drain ticks enough to get past the idle grace, with the session listed as `listed`. */
function ticks(listed = state) {
	for (let i = 0; i < 5; i++) {
		vi.setSystemTime(Date.now() + 1000);
		drainQueues([{ tmux_target: TARGET, state: listed }]);
	}
}

/** Run a delivery past its box-read delays. */
async function settle<T>(promise: Promise<T>): Promise<T> {
	await vi.advanceTimersByTimeAsync(6000);
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	writes.length = 0;
	state = 'idle';
	sessions = null;
	screen = FREE;
	clearQueue(TARGET);
});

afterEach(() => vi.useRealTimers());

afterAll(() => rmSync(queueDir, { recursive: true, force: true }));

describe.each(['waiting', 'permission'])('with the hooks reporting %s', (reported) => {
	beforeEach(() => {
		state = reported;
	});

	it('the send route refuses with a clear error and writes nothing', async () => {
		const res = await post(send, { text: 'please stop, do not run that' });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe('Answer the open dialog first');
		expect(writes).toEqual([]);
	});

	it('the send route refuses text meant for the prompt box without an Enter too', async () => {
		expect((await post(send, { text: 'a draft', raw: true })).status).toBe(409);
		expect(writes).toEqual([]);
	});

	it("the send route still types into the dialog's own text field", async () => {
		expect((await post(send, { text: 'my answer', raw: true, answering: true })).status).toBe(200);
		expect(pasted()).toBe(true);
		expect(enters()).toBe(0);
	});

	it('the send route still takes the keys that answer the dialog', async () => {
		expect((await post(send, { keys: 'Enter' })).status).toBe(200);
		expect(enters()).toBe(1);
	});

	it('the steer route refuses a new message', async () => {
		const res = await post(steer, { text: 'look at this' });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe('Answer the open dialog first');
		expect(writes).toEqual([]);
	});

	it('the steer route leaves a queued item in its place', async () => {
		enqueue(TARGET, 'first');
		const second = enqueue(TARGET, 'second')[1];
		const res = await post(steer, { id: second.id });
		expect(res.status).toBe(409);
		expect((await res.json()).queue.map((m: { text: string }) => m.text)).toEqual(['first', 'second']);
		expect(writes).toEqual([]);
	});

	it('steering does not send the send-now chord either', async () => {
		expect(await settle(steerIntoPane(TARGET, 'look', true, { mode: 'now' }))).toBe('dialog');
		expect(writes).toEqual([]);
	});

	it('the queue waits, and delivers once the dialog is answered', () => {
		enqueue(TARGET, 'later');
		ticks();
		expect(writes).toEqual([]);
		expect(getQueue(TARGET).map((m) => m.text)).toEqual(['later']);

		state = 'idle';
		ticks();
		expect(pasted()).toBe(true);
		expect(getQueue(TARGET)).toEqual([]);
	});

	it('the queue holds on the hooks even when its session list is out of date', () => {
		enqueue(TARGET, 'later');
		ticks('idle');
		expect(writes).toEqual([]);
		expect(getQueue(TARGET)).toHaveLength(1);
	});
});

describe("a local command's dialog, which the hooks never report", () => {
	beforeEach(() => {
		screen = LOCAL_DIALOG;
	});

	it('refuses a send', async () => {
		expect(await submitToPane(TARGET, 'hello')).toBe('dialog');
		expect(writes).toEqual([]);
	});

	it('puts a promoted item back', async () => {
		const [item] = enqueue(TARGET, 'first');
		expect(await promoteToSteer(TARGET, item.id, false)).toBe('dialog');
		expect(getQueue(TARGET).map((m) => m.text)).toEqual(['first']);
		expect(writes).toEqual([]);
	});

	it('holds the queue', () => {
		enqueue(TARGET, 'later');
		ticks();
		expect(writes).toEqual([]);
		expect(getQueue(TARGET)).toHaveLength(1);
	});
});

describe('the screens a pane can show', () => {
	const foot = (...lines: string[]) => lines.join('\n');

	it.each([
		['an unnumbered picker', foot(' ❯ Yesterday', '   Last week', '', ' Enter to select · ↑/↓ to navigate · Esc to cancel')],
		['a scrolled list', foot(' ❯ 4. d', '   5. e', '', ' Enter to select · ↑/↓ to navigate · Esc to cancel')],
		['settings', foot(' ↓ 22 more', ' Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear')],
		['the sign-in', foot(' Paste code here', ' > ', '', ' Esc to cancel')],
		['a rule closing the screen', foot(' ❯ 1. a', ' Enter to select', '──── chat ─')]
	])('refuses %s', async (_name, drawn) => {
		screen = drawn;
		expect(await submitToPane(TARGET, 'hello')).toBe('dialog');
	});

	it('does not read the words typed in the box as a dialog', async () => {
		screen = foot('  1. a', '  2. b', '─'.repeat(40), '❯ what does Esc to cancel do', '─'.repeat(40));
		expect(await settle(submitToPane(TARGET, 'hello'))).toBe('occupied');
	});
});

describe('the Enter behind a raw send', () => {
	it('is refused once a dialog has opened', async () => {
		state = 'permission';
		expect((await post(send, { keys: 'Enter', unlessDialog: true })).status).toBe(409);
		expect(writes).toEqual([]);
	});

	it('goes through otherwise', async () => {
		expect((await post(send, { keys: 'Enter', unlessDialog: true })).status).toBe(200);
		expect(enters()).toBe(1);
	});
});

describe('a pane with an older file left beside its live session', () => {
	it('goes by the newest', async () => {
		sessions = [
			{ id: 'a', tmux_target: TARGET, state: 'waiting', last_update: 1 },
			{ id: 'b', tmux_target: TARGET, state: 'idle', last_update: 2 }
		];
		expect(await paneHasDialog(TARGET)).toBe(false);
		sessions = [sessions[1], { ...sessions[0], last_update: 3 }];
		expect(await paneHasDialog(TARGET)).toBe(true);
	});
});

describe('a dialog opening after the paste', () => {
	it('does not get the retry Enter', async () => {
		// The Enter was lost, so the text still sits in the box when the dialog's hook arrives.
		screen = ['─'.repeat(40), '❯ hello', '─'.repeat(40)].join('\n');
		const sending = submitToPane(TARGET, 'hello');
		await vi.advanceTimersByTimeAsync(500);
		expect(enters()).toBe(1);
		state = 'waiting';
		expect(await settle(sending)).toBe('in-box');
		expect(enters()).toBe(1);
	});
});

describe('a dialog opening while the drain waits on its own message', () => {
	it('does not get the Enter that would have resubmitted it', () => {
		enqueue(TARGET, 'one');
		enqueue(TARGET, 'two');
		ticks('idle');
		expect(enters()).toBe(1);

		// Its Enter was folded into the paste, and now the dialog's hook has arrived.
		screen = ['─'.repeat(40), '❯ one', '─'.repeat(40)].join('\n');
		state = 'waiting';
		for (let i = 0; i < 4; i++) ticks('idle');
		expect(enters()).toBe(1);
		expect(getQueue(TARGET).map((m) => m.text)).toEqual(['two']);
	});
});

describe('a pane with no dialog', () => {
	it('takes a send and a steer', async () => {
		expect((await settle(post(send, { text: 'hello' }))).status).toBe(200);
		writes.length = 0;
		expect((await settle(post(steer, { text: 'hello' }))).status).toBe(200);
		expect(pasted()).toBe(true);
	});
});
