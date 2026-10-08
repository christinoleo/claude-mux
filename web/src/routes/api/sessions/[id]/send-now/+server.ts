import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sendNowInPane } from '$shared/server/message-queue.js';
import { paneForTarget } from '$lib/server/prompt.js';

/**
 * Hand the messages waiting in Claude Code's own queue (`pane_queue`) to the
 * running turn. Only while busy: on an idle pane the chord submits whatever
 * is half-typed in the box, and in a dialog the keys land in the dialog.
 */
export const POST: RequestHandler = async ({ params }) => {
	const { pane, state } = paneForTarget(decodeURIComponent(params.id));
	if (state !== 'busy') {
		return json({ error: 'Nothing is running to send it into' }, { status: 409 });
	}
	try {
		sendNowInPane(pane);
		return json({ ok: true });
	} catch {
		return json({ error: 'Failed to send keys' }, { status: 500 });
	}
};
