import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, updateSession } from '$shared/db/index.js';
import { sendTextToPane } from '$shared/server/message-queue.js';

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
	const name = body.name ?? null;
	updateSession(id, { display_name: name });

	const target = session.tmux_target;
	if (target && name && name.trim().length > 0) {
		setImmediate(() => {
			try {
				sendTextToPane(target, `/rename ${name.trim()}`);
			} catch (err) {
				console.error(`[rename] send-keys to ${target} failed:`, err);
			}
		});
	}

	return json({ ok: true });
};
