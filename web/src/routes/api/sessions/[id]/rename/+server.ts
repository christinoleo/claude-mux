import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, updateSession } from '$shared/db/index.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = params.id;
	if (!getSession(id)) return json({ error: 'Session not found', id }, { status: 404 });
	let body: { name?: string | null };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	updateSession(id, { display_name: body.name ?? null });
	return json({ ok: true });
};
