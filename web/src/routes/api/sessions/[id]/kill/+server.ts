import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { endSession } from '$lib/server/end-session.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => ({}));
	endSession(decodeURIComponent(params.id), body.pid, body.tmux_target);
	return json({ ok: true });
};
