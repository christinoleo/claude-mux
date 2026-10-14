import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureFleetState } from '$lib/server/fleet';

/** "Try now": reach an offline machine at once instead of when its wait is up. */
export const POST: RequestHandler = async ({ params }) => {
	if (!ensureFleetState().retryNow(params.id)) return json({ error: 'unknown machine' }, { status: 404 });
	return json({ ok: true });
};
