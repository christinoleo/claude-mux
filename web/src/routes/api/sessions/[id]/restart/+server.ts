import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { restartClaude, upgradeThenRestart } from '$shared/server/restart-claude.js';

/**
 * Quits Claude Code and reopens the same conversation in the same pane, so it
 * picks up a pending update and re-reads skills and hooks. The session keeps
 * its id across the resume; the hooks refresh the file on SessionStart. With
 * `upgrade: true` the upgrade the pane's notice asks for is run first; the
 * request answers once that command is typed, and the restart follows it.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const session = getSession(decodeURIComponent(params.id));
	if (!session) return json({ error: 'unknown session' }, { status: 404 });
	const body = (await request.json().catch(() => ({}))) as { upgrade?: boolean };
	const outcome = await (body.upgrade === true ? upgradeThenRestart(session) : restartClaude(session));
	return outcome.ok ? json(outcome) : json(outcome, { status: 409 });
};
