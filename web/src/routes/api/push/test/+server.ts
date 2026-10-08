import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPushSubscription, removePushSubscriptions } from '$shared/db/index.js';
import { isGone } from '$shared/server/push.js';
import { sendPush } from '$lib/server/push.js';

/**
 * Push a sample to one device (`{ endpoint }`), so setting it up can be
 * checked without waiting for a session to need someone.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
	const subscription = typeof body?.endpoint === 'string' ? getPushSubscription(body.endpoint) : null;
	if (!subscription) return json({ error: 'Not subscribed' }, { status: 404 });
	try {
		await sendPush(subscription, {
			title: 'claude-mux',
			body: 'Push works on this device.',
			tag: 'claude-mux-test',
			url: '/',
			kind: 'input'
		});
	} catch (err) {
		if (isGone(err)) {
			removePushSubscriptions([subscription.endpoint]);
			return json({ error: 'The push service no longer knows this device. Turn push off and on again.' }, { status: 410 });
		}
		return json({ error: `The push service refused the message (${(err as { statusCode?: number }).statusCode ?? String(err)})` }, { status: 502 });
	}
	return json({ ok: true });
};
