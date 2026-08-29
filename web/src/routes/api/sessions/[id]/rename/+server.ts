import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, updateSession, sanitizeDisplayName } from '$shared/db/index.js';
import { enqueue } from '$shared/server/message-queue.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = params.id;
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	let body: { name?: string | null };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const name = sanitizeDisplayName(body.name);
	updateSession(id, { display_name: name });
	broadcastSessions();

	// Mirror the name into the agent so its own transcript title matches. Nobody
	// is at the keyboard for this one, so it goes through the queue rather than
	// straight to the pane: the queue already knows not to type into a permission
	// dialog, not to jump ahead of pending messages, and not to land on a prompt
	// it has just fired at.
	if (session.tmux_target && name) {
		enqueue(session.tmux_target, `/rename ${name}`, 'control');
	}

	return json({ ok: true });
};
