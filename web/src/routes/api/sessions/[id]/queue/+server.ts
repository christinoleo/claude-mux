import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueue, getQueue, removeFromQueue, reorderQueue, clearQueue } from '$shared/server/message-queue.js';
import {
	composePromptWithAttachments,
	validateAttachmentPaths
} from '$shared/server/attachments.js';
import { getAllSessions } from '$shared/db/index.js';

function findSessionIdByTarget(target: string): string | null {
	const sessions = getAllSessions();
	const match = sessions.find((s) => s.tmux_target === target);
	if (match) return match.id;
	if (sessions.some((s) => s.id === target)) return target;
	return null;
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
	let finalText = text.trim();
	const attachments: unknown = body.attachments;
	if (Array.isArray(attachments) && attachments.length > 0) {
		const sessionId = findSessionIdByTarget(target);
		if (!sessionId) {
			return json({ error: 'attachments require a known session' }, { status: 400 });
		}
		const result = validateAttachmentPaths(sessionId, attachments as string[]);
		if (!result.ok) {
			return json({ error: result.error }, { status: 400 });
		}
		finalText = composePromptWithAttachments(finalText, result.paths);
	}
	const queue = enqueue(target, finalText);
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
