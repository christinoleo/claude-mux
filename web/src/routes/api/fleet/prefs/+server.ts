import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureFleetPrefs } from '$lib/server/fleet';
import { isServerOnlyKey } from '$shared/fleet-prefs.js';

/**
 * Write one fleet preference, `{ key, value }`. It reaches this machine's
 * pages and every peer on the sessions socket; the answer is the whole set
 * after the write, as a page is sent it. The keys the servers keep among
 * themselves (push's) are not a page's to write.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
	const store = ensureFleetPrefs();
	if (!body || typeof body.key !== 'string' || isServerOnlyKey(body.key) || !store.set(body.key, body.value)) {
		return json({ error: 'expected { key, value }' }, { status: 400 });
	}
	return json({ prefs: store.forPages() });
};
