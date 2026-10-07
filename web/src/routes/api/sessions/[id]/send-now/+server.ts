import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sendNowInPane } from '$shared/server/message-queue.js';

/** Hand the messages waiting in Claude Code's own queue (`pane_queue`) to the running turn. */
export const POST: RequestHandler = async ({ params }) => {
	const target = decodeURIComponent(params.id);
	try {
		sendNowInPane(target);
		return json({ ok: true });
	} catch {
		return json({ error: 'Failed to send keys' }, { status: 500 });
	}
};
