import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAllSessions, getSession } from '$shared/db/index.js';
import { enqueue } from '$shared/server/message-queue.js';

/**
 * Turn Remote Control on in a session: `/rc`, through the control queue, so
 * it lands when the prompt is free rather than in the middle of a dialog.
 * The param may be a session id or its tmux target, like the other routes.
 */
export const POST: RequestHandler = async ({ params }) => {
	const key = decodeURIComponent(params.id);
	const session = getSession(key) ?? getAllSessions().find((s) => s.tmux_target === key) ?? null;
	if (!session) return json({ error: 'Session not found', id: key }, { status: 404 });
	if (!session.tmux_target) return json({ error: 'Session has no tmux pane' }, { status: 409 });
	if (session.rc_url) return json({ ok: true, already: true, url: session.rc_url });
	enqueue(session.tmux_target, '/rc', 'control');
	return json({ ok: true });
};
