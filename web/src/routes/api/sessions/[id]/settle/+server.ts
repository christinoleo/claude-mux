import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnrichedSessionsAsync } from '$shared/server/ws-handlers.js';
import { settleCloses } from '$shared/server/past-resume.js';
import { endSession } from '$lib/server/end-session.js';

/**
 * Settling a session (spec #92): the page records it as settled, a fleet
 * preference, and asks the session's machine here whether that ends it.
 * Claude Code idle at its prompt is ended and its pane closed; anything else
 * keeps running. Decided here, on the machine, from the state it reads now.
 */
export const POST: RequestHandler = async ({ params }) => {
	const id = decodeURIComponent(params.id);
	const session = (await getEnrichedSessionsAsync()).find((s) => s.id === id);
	if (!session || !settleCloses(session)) return json({ ok: true, closed: false });
	endSession(session.id, session.pid, session.tmux_target);
	return json({ ok: true, closed: true });
};
