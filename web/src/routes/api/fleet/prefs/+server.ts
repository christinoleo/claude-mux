import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureFleetPrefs } from '$lib/server/fleet';

/**
 * Write one fleet preference, `{ key, value }`. It reaches this machine's
 * pages and every peer on the sessions socket; the answer is the whole set
 * after the write.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
	const store = ensureFleetPrefs();
	if (!body || typeof body.key !== 'string' || !store.set(body.key, body.value)) {
		return json({ error: 'expected { key, value }' }, { status: 400 });
	}
	return json({ prefs: store.all() });
};
