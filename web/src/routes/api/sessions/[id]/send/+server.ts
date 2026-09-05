import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { confirmSubmitted, sendTextToPane } from '$shared/server/message-queue.js';
import {
	composePromptWithAttachments,
	validateAttachmentPaths
} from '$shared/server/attachments.js';
import { getAllSessions } from '$shared/db/index.js';

/**
 * The URL param is normally a tmux target (e.g. "main:1.0"), not a session id.
 * Attachments are keyed by session id, so look up the session via its
 * tmux_target. If no session matches (e.g. raw tmux pane), attachments can't
 * be validated and must be empty.
 */
function findSessionIdByTarget(target: string): string | null {
	const sessions = getAllSessions();
	const match = sessions.find((s) => s.tmux_target === target);
	if (match) return match.id;
	// Fallback: caller may have passed a session id directly.
	if (sessions.some((s) => s.id === target)) return target;
	return null;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const keys = body.keys || 'Escape';
	const rawText: string = typeof body.text === 'string' ? body.text : '';
	const raw = body.raw === true;
	const attachments: unknown = body.attachments;

	let finalText = rawText;

	if (Array.isArray(attachments) && attachments.length > 0) {
		const sessionId = findSessionIdByTarget(target);
		if (!sessionId) {
			return json({ error: 'attachments require a known session' }, { status: 400 });
		}
		const result = validateAttachmentPaths(sessionId, attachments as string[]);
		if (!result.ok) {
			return json({ error: result.error }, { status: 400 });
		}
		finalText = composePromptWithAttachments(rawText, result.paths);
	}

	try {
		if (finalText) {
			sendTextToPane(target, finalText, { appendEnter: !raw });
			if (!raw && !(await confirmSubmitted(target))) {
				return json(
					{ error: 'Claude Code did not take the message; it is still in its input box' },
					{ status: 502 }
				);
			}
		} else {
			// Send each key separately so repeated keys (e.g. C-b C-b) work correctly
			for (const key of keys.split(' ')) {
				execFileSync('tmux', ['send-keys', '-t', target, key], { stdio: 'ignore' });
			}
		}
		return json({ ok: true });
	} catch {
		return json({ error: 'Failed to send keys' }, { status: 500 });
	}
};
