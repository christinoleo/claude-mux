import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueue, getQueue, removeFromQueue, reorderQueue, clearQueue } from '$shared/server/message-queue.js';

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
	const queue = enqueue(target, text.trim());
	return json({ queue });
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json().catch(() => ({}));
	const index = body.index;
	if (typeof index === 'number') {
		const queue = removeFromQueue(target, index);
		return json({ queue });
	}
	// No index — clear all
	clearQueue(target);
	return json({ queue: [] });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const { fromIndex, toIndex } = body;
	if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
		return json({ error: 'fromIndex and toIndex are required' }, { status: 400 });
	}
	const queue = reorderQueue(target, fromIndex, toIndex);
	return json({ queue });
};
