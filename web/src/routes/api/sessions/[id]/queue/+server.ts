import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	enqueue,
	getQueue,
	removeFromQueue,
	reorderQueue,
	clearQueue,
	editQueueItem
} from '$shared/server/message-queue.js';
import { composePrompt } from '$lib/server/prompt.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/** Answer with the queue, and push it to every dashboard without waiting for the poll. */
function changed(queue: unknown) {
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
 * `{ index, text }` replaces that item's text in place; `{ fromIndex, toIndex }`
 * moves an item.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const { index, text, fromIndex, toIndex } = body;
	if (typeof index === 'number' && typeof text === 'string') {
		if (!text.trim()) return json({ error: 'text must not be empty' }, { status: 400 });
		return changed(editQueueItem(target, index, text.trim()));
	}
	if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
		return json(
			{ error: 'either index and text, or fromIndex and toIndex, are required' },
			{ status: 400 }
		);
	}
	return changed(reorderQueue(target, fromIndex, toIndex));
};
