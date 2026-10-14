import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionForTarget } from '$lib/server/prompt.js';
import { setRemoteControl } from '$shared/server/remote-control.js';

/** The param may be a session id or its tmux target, like the other routes. */
function answer(id: string, on: boolean) {
	const key = decodeURIComponent(id);
	const session = sessionForTarget(key);
	if (!session) return json({ error: 'Session not found', id: key }, { status: 404 });
	const outcome = setRemoteControl(session, on);
	return outcome.ok ? json(outcome) : json({ error: outcome.error }, { status: outcome.status });
}

/** Turn Remote Control on; the poll picks up the URL. */
export const POST: RequestHandler = ({ params }) => answer(params.id, true);

/** Turn Remote Control off; the poll answers the dialog and sees it end. */
export const DELETE: RequestHandler = ({ params }) => answer(params.id, false);
