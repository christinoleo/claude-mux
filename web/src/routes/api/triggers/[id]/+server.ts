import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { scheduler } from '$lib/server/triggers.js';

function refused(request: Request) {
	return !pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'));
}

/** `{ paused }`: pause or resume a clock Trigger. */
export const PATCH: RequestHandler = async ({ request, params }) => {
	if (refused(request)) return json({ error: 'cross-origin request refused' }, { status: 403 });
	const s = scheduler();
	if (!s) return json({ error: 'This server runs no scheduler' }, { status: 409 });
	const body = (await request.json().catch(() => null)) as { paused?: unknown } | null;
	if (typeof body?.paused !== 'boolean') return json({ error: 'paused must be true or false' }, { status: 400 });
	const trigger = s.setPaused(params.id, body.paused);
	return trigger ? json({ ok: true }) : json({ error: 'No such trigger' }, { status: 404 });
};

export const DELETE: RequestHandler = async ({ request, params }) => {
	if (refused(request)) return json({ error: 'cross-origin request refused' }, { status: 403 });
	const s = scheduler();
	if (!s) return json({ error: 'This server runs no scheduler' }, { status: 409 });
	return s.remove(params.id) ? json({ ok: true }) : json({ error: 'No such trigger' }, { status: 404 });
};
