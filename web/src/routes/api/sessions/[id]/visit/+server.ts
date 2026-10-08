import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, recordVisit, markUnread } from '$shared/db/index.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/**
 * Someone has the session open (`{}`), or wants its last turn back to unread
 * (`{ unread: true }`). The watermark is the server's, so every browser and
 * phone sees the same "Done".
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const body = (await request.json().catch(() => ({}))) as { unread?: unknown };

	if (body.unread === true) {
		if (!markUnread(id, session.turn_completed_at)) {
			return json({ error: 'No finished turn to mark unread' }, { status: 409 });
		}
	} else {
		recordVisit(id);
	}
	broadcastSessions();
	return json({ ok: true });
};
