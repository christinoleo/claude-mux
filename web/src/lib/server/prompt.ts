import { getAllSessions, type Session } from '$shared/db/index.js';
import {
	composePromptWithAttachments,
	validateAttachmentPaths
} from '$shared/server/attachments.js';

/**
 * The session a route's URL param names. The param is normally a tmux target
 * (e.g. "main:1.0"), but a caller may pass a session id. Undefined for a raw
 * tmux pane no session claims.
 */
export function sessionForTarget(target: string): Session | undefined {
	const sessions = getAllSessions();
	return sessions.find((s) => s.tmux_target === target) ?? sessions.find((s) => s.id === target);
}

/**
 * The tmux pane a route's URL param names, and the state its session is in.
 * A session id resolves to its pane; a raw tmux target passes through, with
 * no state.
 */
export function paneForTarget(target: string): { pane: string; state: Session['state'] | undefined } {
	const session = sessionForTarget(target);
	return { pane: session?.tmux_target ?? target, state: session?.state };
}

/**
 * The attachment paths a request names, checked to sit under the session's
 * own attachments dir. Attachments are keyed by session id, so a pane no
 * session claims can take none.
 */
export function attachmentPaths(
	target: string,
	attachments: unknown
): { ok: true; paths: string[] } | { ok: false; error: string } {
	if (!Array.isArray(attachments) || attachments.length === 0) return { ok: true, paths: [] };
	const session = sessionForTarget(target);
	if (!session) return { ok: false, error: 'attachments require a known session' };
	return validateAttachmentPaths(session.id, attachments as string[]);
}

/** The text to deliver, with any attachments folded in. */
export function composePrompt(
	target: string,
	text: string,
	attachments: unknown
): { ok: true; text: string } | { ok: false; error: string } {
	const result = attachmentPaths(target, attachments);
	if (!result.ok) return result;
	return { ok: true, text: composePromptWithAttachments(text, result.paths) };
}
