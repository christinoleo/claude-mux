import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Session } from '../db/sessions-json.js';
import { CLAUDE_DIR } from '../utils/paths.js';
import { enqueue } from './message-queue.js';
import { sendKeyAsync } from '../tmux/pane.js';
import { keysForOptionPick } from '../tmux/answer-keys.js';

/**
 * Where Remote Control stands for a session, from the two things that say so.
 *
 * Claude Code keeps a file per process in `~/.claude/sessions/<pid>.json`,
 * and its `bridgeSessionId` is the Remote Control session while one is
 * connected and `null` once it is not. That file is authoritative. Builds that
 * write no such field leave only the pane: the URL `/rc` prints, and the
 * "Remote Control disconnected." it prints on the way out, whichever was
 * drawn last.
 */

const SESSION_URL = 'https://claude.ai/code/';

function claudeSessionsDir(): string {
	return process.env.CLAUDE_SESSIONS_DIR ?? join(CLAUDE_DIR, 'sessions');
}

/**
 * The last answer read from each record, by the stat it was read at. The poll
 * asks for every session twice a second and the record seldom changes, so a
 * stat that matches the last one is answered without opening the file.
 */
const bridgeMemo = new Map<string, { mtimeMs: number; size: number; url: string | null | undefined }>();

/**
 * The Remote Control URL Claude Code's own record gives for a process:
 * a URL while it is on, null while it is off, undefined when the record is
 * missing or predates the field, and the pane has to be read instead.
 */
export function readBridgeUrl(pid: number): string | null | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const path = join(claudeSessionsDir(), `${pid}.json`);
	let stat: { mtimeMs: number; size: number };
	try {
		stat = statSync(path);
	} catch {
		bridgeMemo.delete(path);
		return undefined;
	}
	const memo = bridgeMemo.get(path);
	if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.url;
	const url = parseBridgeUrl(path);
	bridgeMemo.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, url });
	return url;
}

function parseBridgeUrl(path: string): string | null | undefined {
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		return undefined;
	}
	if (!record || typeof record !== 'object' || !('bridgeSessionId' in record)) return undefined;
	const id = (record as { bridgeSessionId: unknown }).bridgeSessionId;
	if (id === null) return null;
	return typeof id === 'string' && /^[\w-]+$/.test(id) ? SESSION_URL + id : undefined;
}

/** Only a Remote Control session's link: claude.ai/code also serves artifacts and the like. */
const URL_PATTERN = /https:\/\/claude\.ai\/code\/session_[\w-]+/g;
/** The result line `/rc` leaves behind, not the phrase quoted in prose. */
const ENDED_PATTERN = /⎿\s+Remote Control disconnected/g;

/**
 * What the pane last said about Remote Control: the URL it showed, null when
 * the last word was the disconnect, undefined when it says neither. The URL
 * scrolls away in a long session, so saying neither means nothing changed.
 */
export function readPaneRemoteControl(content: string): string | null | undefined {
	if (!content) return undefined;
	let url: { at: number; text: string } | null = null;
	for (const m of content.matchAll(URL_PATTERN)) url = { at: m.index, text: m[0] };
	let endedAt = -1;
	for (const m of content.matchAll(ENDED_PATTERN)) endedAt = m.index;
	if (url && url.at > endedAt) return url.text;
	return endedAt >= 0 ? null : undefined;
}

/** The session's Remote Control URL as it stands now: the record's word, else the pane's, else unchanged. */
export function currentRemoteControlUrl(session: Session, paneContent: string): string | null {
	const fromRecord = readBridgeUrl(session.pid);
	if (fromRecord !== undefined) return fromRecord;
	const fromPane = readPaneRemoteControl(paneContent);
	return fromPane === undefined ? (session.rc_url ?? null) : fromPane;
}

/**
 * Panes asked to turn Remote Control on or off, and when. `/rc` waits in the
 * control queue for the turn to end, so an ask lives as long as a long turn
 * might. Kept in globalThis: in dev the route and the poll load this module
 * separately, and both must see the same asks.
 */
type Ask = { way: 'on' | 'off'; at: number; settledAt?: number };
const asks = ((globalThis as typeof globalThis & {
	__claudeMuxRcAsks?: Map<string, Ask>;
}).__claudeMuxRcAsks ??= new Map<string, Ask>());
const ASK_TTL_MS = 10 * 60_000;
/**
 * How long an ask to turn on outlives the URL appearing. Claude Code may
 * record the bridge before it draws the dialog that wants answering, and
 * newer builds draw none at all.
 */
const SETTLE_MS = 3_000;

function liveAsk(target: string): Ask | undefined {
	const ask = asks.get(target);
	if (ask && Date.now() - ask.at > ASK_TTL_MS) {
		asks.delete(target);
		return undefined;
	}
	return ask;
}

export type RemoteControlOutcome =
	| { ok: true; already?: boolean; url?: string }
	| { ok: false; status: number; error: string };

/**
 * Ask a session to turn Remote Control on or off. Both go as `/rc` through the
 * control queue, so it lands when the prompt is free; the dialog it may draw is
 * answered by `answerRemoteControlDialog()`. An ask already on its way is not
 * sent twice, since a second `/rc` would undo the first.
 */
export function setRemoteControl(session: Session, on: boolean): RemoteControlOutcome {
	if (!session.tmux_target) return { ok: false, status: 409, error: 'Session has no tmux pane' };
	if (on && session.rc_url) return { ok: true, already: true, url: session.rc_url };
	if (!on && !session.rc_url) return { ok: true, already: true };
	if (liveAsk(session.tmux_target)) return { ok: true, already: true };
	asks.set(session.tmux_target, { way: on ? 'on' : 'off', at: Date.now() });
	enqueue(session.tmux_target, '/rc', 'control');
	return { ok: true };
}

const DIALOG_HINT = /Enter to select · Esc to continue/;

/** The keys that move the dialog's cursor to "Disconnect this session" and pick it, or null if it is not drawn. */
export function disconnectKeys(content: string): string[] | null {
	const lines = content.split('\n');
	let hint = lines.length - 1;
	while (hint >= 0 && !DIALOG_HINT.test(lines[hint])) hint--;
	if (hint < 0) return null;
	let disconnect = -1;
	let cursor = -1;
	for (let i = hint - 1; i >= 0 && i >= hint - 8; i--) {
		if (disconnect < 0 && /Disconnect this session/.test(lines[i])) disconnect = i;
		if (cursor < 0 && /^\s*❯\s/.test(lines[i])) cursor = i;
	}
	if (disconnect < 0 || cursor < 0) return null;
	return keysForOptionPick(cursor, disconnect, hint)?.split(' ') ?? null;
}

async function press(target: string, keys: string[]): Promise<boolean> {
	for (const key of keys) if (!(await sendKeyAsync(target, key))) return false;
	return true;
}

/**
 * Answer the dialog `/rc` draws for a pane that asked claude-mux to turn
 * Remote Control: Disconnect to turn it off, Continue to turn it on (the
 * dialog only shows the URL, which the poll has recorded). A dialog the person
 * opened themselves is theirs. `rcUrl` is what the poll now holds for the
 * session. Returns whether keys were sent.
 */
export async function answerRemoteControlDialog(
	target: string,
	content: string,
	rcUrl: string | null
): Promise<boolean> {
	const ask = liveAsk(target);
	if (!ask) return false;
	const drawn = DIALOG_HINT.test(content) && /Disconnect this session/.test(content);
	if (ask.way === 'off') {
		const keys = drawn ? disconnectKeys(content) : null;
		if (!keys) {
			if (rcUrl === null) asks.delete(target);
			return false;
		}
		if (await press(target, keys)) asks.delete(target);
		return true;
	}
	if (drawn && /❯\s*Continue/.test(content)) {
		if (await press(target, ['Enter'])) asks.delete(target);
		return true;
	}
	if (rcUrl !== null) {
		ask.settledAt ??= Date.now();
		if (Date.now() - ask.settledAt > SETTLE_MS) asks.delete(target);
	}
	return false;
}
