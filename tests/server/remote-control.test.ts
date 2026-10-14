import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../../src/db/sessions-json.js';

const dir = mkdtempSync(join(tmpdir(), 'claude-mux-rc-'));
process.env.CLAUDE_SESSIONS_DIR = dir;

const enqueued: Array<[string, string, string]> = [];
const keys: Array<[string, string]> = [];

vi.mock('../../src/server/message-queue.js', () => ({
	enqueue: vi.fn((target: string, text: string, kind: string) => enqueued.push([target, text, kind]))
}));
vi.mock('../../src/tmux/pane.js', () => ({
	sendKeyAsync: vi.fn(async (target: string, key: string) => (keys.push([target, key]), true))
}));

const {
	readBridgeUrl,
	readPaneRemoteControl,
	currentRemoteControlUrl,
	setRemoteControl,
	disconnectKeys,
	answerRemoteControlDialog
} = await import('../../src/server/remote-control.js');

const URL = 'https://claude.ai/code/session_01S5NAUQ9NfSBTi89PDF7SdG';

/** Claude Code's own record of a process, as `~/.claude/sessions/<pid>.json` holds it. */
function record(pid: number, fields: Record<string, unknown>) {
	writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: 'abc', status: 'idle', ...fields }));
}

function session(over: Partial<Session> = {}): Session {
	return { id: 's1', pid: 4242, tmux_target: 'rc:1.0', rc_url: null, ...over } as Session;
}

/** The dialog `/rc` draws while Remote Control is on, captured from Claude Code 2.1.296. */
const DIALOG = (cursorOn: 'Disconnect' | 'Continue') =>
	[
		'❯ /remote-control',
		'  /remote-control is active · Continue here, on your phone, or at ' + URL,
		'────────────────────────────────',
		'   Remote Control',
		'   This session is available in the Claude mobile app and at ' + URL + '.',
		`   ${cursorOn === 'Disconnect' ? '❯' : ' '} Disconnect this session`,
		'     Show QR code   Scan with your phone to open this session',
		`   ${cursorOn === 'Continue' ? '❯' : ' '} Continue`,
		'   Enter to select · Esc to continue'
	].join('\n');

beforeEach(() => {
	enqueued.length = 0;
	keys.length = 0;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readBridgeUrl', () => {
	it('reads the link while Remote Control is connected', () => {
		record(101, { bridgeSessionId: 'session_01S5NAUQ9NfSBTi89PDF7SdG' });
		expect(readBridgeUrl(101)).toBe(URL);
	});

	it('says off once the bridge is gone', () => {
		record(102, { bridgeSessionId: null });
		expect(readBridgeUrl(102)).toBeNull();
	});

	it('knows nothing from a build that writes no bridge field, or no record at all', () => {
		record(103, {});
		expect(readBridgeUrl(103)).toBeUndefined();
		expect(readBridgeUrl(999_999)).toBeUndefined();
		expect(readBridgeUrl(0)).toBeUndefined();
	});

	it('ignores an id that is not one', () => {
		record(104, { bridgeSessionId: '../../evil' });
		expect(readBridgeUrl(104)).toBeUndefined();
	});
});

describe('readPaneRemoteControl', () => {
	it('reads the URL without the sentence’s full stop', () => {
		expect(readPaneRemoteControl('   This session is available at ' + URL + '.')).toBe(URL);
	});

	it('says off when the disconnect came after the URL', () => {
		const pane = ['  /remote-control is active · at ' + URL, '❯ /remote-control', '  ⎿  Remote Control disconnected.'].join('\n');
		expect(readPaneRemoteControl(pane)).toBeNull();
	});

	it('says on when it was turned on again after a disconnect', () => {
		const pane = ['  ⎿  Remote Control disconnected.', '  /remote-control is active · at ' + URL].join('\n');
		expect(readPaneRemoteControl(pane)).toBe(URL);
	});

	it('reads no other claude.ai/code link, and no mention of the phrase in prose', () => {
		expect(readPaneRemoteControl('see https://claude.ai/code/artifact/0b5c')).toBeUndefined();
		expect(readPaneRemoteControl('"Remote Control disconnected." it prints')).toBeUndefined();
	});

	it('says nothing when neither is on screen, so a URL scrolled away keeps the session on', () => {
		expect(readPaneRemoteControl('❯ \n──────\n  [░░░░] 0% ctx')).toBeUndefined();
		expect(currentRemoteControlUrl(session({ pid: 0, rc_url: URL }), '❯ ')).toBe(URL);
	});
});

describe('currentRemoteControlUrl', () => {
	it('believes Claude Code’s record over the pane', () => {
		record(201, { bridgeSessionId: null });
		expect(currentRemoteControlUrl(session({ pid: 201, rc_url: URL }), 'at ' + URL)).toBeNull();
	});

	it('falls back to the pane where the record is silent', () => {
		expect(currentRemoteControlUrl(session({ pid: 0 }), 'at ' + URL)).toBe(URL);
	});
});

describe('setRemoteControl', () => {
	it('turns on with /rc through the control queue, once while the ask is on its way', () => {
		expect(setRemoteControl(session({ tmux_target: 'once:1.0' }), true)).toEqual({ ok: true });
		expect(setRemoteControl(session({ tmux_target: 'once:1.0' }), true)).toEqual({ ok: true, already: true });
		expect(enqueued).toEqual([['once:1.0', '/rc', 'control']]);
	});

	it('does nothing to a session already in the state asked for', () => {
		expect(setRemoteControl(session({ rc_url: URL }), true)).toEqual({ ok: true, already: true, url: URL });
		expect(setRemoteControl(session(), false)).toEqual({ ok: true, already: true });
		expect(enqueued).toEqual([]);
	});

	it('refuses a session without a pane', () => {
		expect(setRemoteControl(session({ tmux_target: null }), false)).toMatchObject({ ok: false, status: 409 });
	});

	it('turns off by opening the dialog and picking Disconnect once it is drawn', async () => {
		const s = session({ tmux_target: 'off:1.0', rc_url: URL });
		expect(setRemoteControl(s, false)).toEqual({ ok: true });
		expect(enqueued).toEqual([['off:1.0', '/rc', 'control']]);

		// Before the dialog is up, nothing is pressed.
		expect(await answerRemoteControlDialog('off:1.0', '❯ /remote-control', URL)).toBe(false);
		expect(await answerRemoteControlDialog('off:1.0', DIALOG('Continue'), URL)).toBe(true);
		expect(keys).toEqual([
			['off:1.0', 'Up'],
			['off:1.0', 'Up'],
			['off:1.0', 'Enter']
		]);

		// The ask is spent: the same dialog drawn again is left to the person.
		keys.length = 0;
		expect(await answerRemoteControlDialog('off:1.0', DIALOG('Continue'), URL)).toBe(false);
		expect(keys).toEqual([]);
	});
});

describe('answerRemoteControlDialog', () => {
	it('closes the dialog on Continue for a pane asked to turn on, even after the URL was recorded', async () => {
		setRemoteControl(session({ tmux_target: 'on:1.0' }), true);
		// The record can say on before the dialog is drawn.
		expect(await answerRemoteControlDialog('on:1.0', '❯ /remote-control', URL)).toBe(false);
		expect(await answerRemoteControlDialog('on:1.0', DIALOG('Continue'), URL)).toBe(true);
		expect(keys).toEqual([['on:1.0', 'Enter']]);
	});

	it('lets an ask to turn on go once the URL has settled with no dialog', async () => {
		vi.useFakeTimers();
		try {
			setRemoteControl(session({ tmux_target: 'quiet:1.0' }), true);
			await answerRemoteControlDialog('quiet:1.0', '', URL);
			vi.advanceTimersByTime(5_000);
			await answerRemoteControlDialog('quiet:1.0', '', URL);
			// A dialog opened later is the person's.
			expect(await answerRemoteControlDialog('quiet:1.0', DIALOG('Continue'), URL)).toBe(false);
			expect(keys).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves a dialog the person opened alone', async () => {
		expect(await answerRemoteControlDialog('mine:1.0', DIALOG('Continue'), URL)).toBe(false);
		expect(keys).toEqual([]);
	});
});

describe('disconnectKeys', () => {
	it('counts the rows from the cursor to Disconnect', () => {
		expect(disconnectKeys(DIALOG('Continue'))).toEqual(['Up', 'Up', 'Enter']);
		expect(disconnectKeys(DIALOG('Disconnect'))).toEqual(['Enter']);
	});

	it('finds nothing without the dialog', () => {
		expect(disconnectKeys('  ⎿  Remote Control disconnected.')).toBeNull();
	});
});
