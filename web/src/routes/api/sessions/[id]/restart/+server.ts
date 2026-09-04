import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { restartClaude } from '$shared/server/restart-claude.js';

/**
 * Quits Claude Code and reopens the same conversation in the same pane, so it
 * picks up a pending update and re-reads skills and hooks. The session keeps
 * its id across the resume; the hooks refresh the file on SessionStart.
 */
export const POST: RequestHandler = async ({ params }) => {
	const session = getSession(decodeURIComponent(params.id));
	if (!session) return json({ error: 'unknown session' }, { status: 404 });
	const outcome = await restartClaude(session);
	return outcome.ok ? json(outcome) : json(outcome, { status: 409 });
};
