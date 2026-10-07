import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { promoteToSteer, steerIntoPane } from '$shared/server/message-queue.js';
import { composePrompt, sessionForTarget } from '$lib/server/prompt.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

const NOT_TAKEN = 'Claude Code did not take the message; it is still in its input box';

/**
 * Push a message into the running turn now. The body is either what `/send`
 * takes (`text`, `attachments`), or `{ index }` to steer that item out of the
 * server queue. A session that is not busy takes it as a normal send; one
 * showing a dialog refuses it, since pasted text would answer the dialog.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const state = sessionForTarget(target)?.state;
	if (state === 'waiting' || state === 'permission') {
		return json({ error: 'Answer the open dialog first' }, { status: 409 });
	}
	const busy = state === 'busy';

	try {
		if (typeof body.index === 'number') {
			const { ok, queue } = await promoteToSteer(target, body.index, busy);
			broadcastSessions();
			return ok ? json({ ok, queue }) : json({ error: NOT_TAKEN, queue }, { status: 502 });
		}

		const text = typeof body.text === 'string' ? body.text.trim() : '';
		if (!text) return json({ error: 'text or index is required' }, { status: 400 });
		const prompt = composePrompt(target, text, body.attachments);
		if (!prompt.ok) return json({ error: prompt.error }, { status: 400 });
		if (!(await steerIntoPane(target, prompt.text, busy))) {
			return json({ error: NOT_TAKEN }, { status: 502 });
		}
		return json({ ok: true });
	} catch {
		return json({ error: 'Failed to steer' }, { status: 500 });
	}
};
