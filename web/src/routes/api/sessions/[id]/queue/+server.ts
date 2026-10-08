import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	enqueue,
	getQueue,
	removeFromQueue,
	reorderQueue,
	clearQueue,
	editQueueItem,
	type QueuedMessage
} from '$shared/server/message-queue.js';
import { composePrompt } from '$lib/server/prompt.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/** Answer with the queue, and push it to every dashboard without waiting for the poll. */
function changed(queue: QueuedMessage[]) {
	broadcastSessions();
	return json({ queue });
}

export const GET: RequestHandler = async ({ params }) => {
	const target = decodeURIComponent(params.id);
	return json({ queue: getQueue(target) });
};

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const text = body.text;
	if (!text || typeof text !== 'string') {
		return json({ error: 'text is required' }, { status: 400 });
	}
	const prompt = composePrompt(target, text.trim(), body.attachments);
	if (!prompt.ok) return json({ error: prompt.error }, { status: 400 });
	return changed(enqueue(target, prompt.text));
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json().catch(() => ({}));
	const index = body.index;
	if (typeof index === 'number') {
		return changed(removeFromQueue(target, index));
	}
	// No index — clear all
	clearQueue(target);
	return changed([]);
};

/**
 * `{ id, text }` replaces that item's text in place (404 once it has left the
 * queue); `{ fromIndex, toIndex }` moves an item.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const { id, text, fromIndex, toIndex } = body;
	if (typeof id === 'string' && typeof text === 'string') {
		if (!text.trim()) return json({ error: 'text must not be empty' }, { status: 400 });
		if (!editQueueItem(target, id, text.trim())) {
			return json({ error: 'That message has already left the queue', queue: getQueue(target) }, { status: 404 });
		}
		return changed(getQueue(target));
	}
	if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
		return json(
			{ error: 'either id and text, or fromIndex and toIndex, are required' },
			{ status: 400 }
		);
	}
	return changed(reorderQueue(target, fromIndex, toIndex));
};
