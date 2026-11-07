import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { schedulerFor } from '$lib/server/triggers.js';

/** `{ paused }`: pause or resume a clock Trigger. */
export const PATCH: RequestHandler = async ({ request, params }) => {
	const s = schedulerFor(request);
	if (s instanceof Response) return s;
	const body = (await request.json().catch(() => null)) as { paused?: unknown } | null;
	if (typeof body?.paused !== 'boolean') return json({ error: 'paused must be true or false' }, { status: 400 });
	return s.setPaused(params.id, body.paused) ? json({ ok: true }) : json({ error: 'No such trigger' }, { status: 404 });
};

export const DELETE: RequestHandler = async ({ request, params }) => {
	const s = schedulerFor(request);
	if (s instanceof Response) return s;
	return s.remove(params.id) ? json({ ok: true }) : json({ error: 'No such trigger' }, { status: 404 });
};
