import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getPushSubscription,
	removePushSubscriptions,
	savePushSubscription,
	type PushEvents
} from '$shared/db/index.js';

/** Which events this device takes (`?endpoint=`), or 404 when the server does not know it. */
export const GET: RequestHandler = ({ url }) => {
	const endpoint = url.searchParams.get('endpoint');
	const subscription = endpoint ? getPushSubscription(endpoint) : null;
	if (!subscription) return json({ error: 'Not subscribed' }, { status: 404 });
	return json({ events: subscription.events });
};

/** Subscribe a device, or change which events it takes: `{ endpoint, keys: { p256dh, auth }, events }`. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		endpoint?: unknown;
		keys?: { p256dh?: unknown; auth?: unknown };
		events?: Partial<Record<keyof PushEvents, unknown>>;
	} | null;
	const endpoint = body?.endpoint;
	const p256dh = body?.keys?.p256dh;
	const auth = body?.keys?.auth;
	if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string') {
		return json({ error: 'Expected a push subscription: endpoint and keys' }, { status: 400 });
	}
	const record = savePushSubscription({
		endpoint,
		keys: { p256dh, auth },
		events: { needsYou: body?.events?.needsYou !== false, done: body?.events?.done !== false }
	});
	return json({ events: record.events });
};

/** Forget a device: `{ endpoint }`. */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
	if (typeof body?.endpoint !== 'string') return json({ error: 'Expected an endpoint' }, { status: 400 });
	removePushSubscriptions([body.endpoint]);
	return json({ ok: true });
};
