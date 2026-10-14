import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { PushEvents } from '$shared/fleet-push.js';
import { fleetPush, vapidKeys } from '$lib/server/push.js';

/**
 * Which events this device takes (`?endpoint=`), and whether it subscribed
 * under the fleet's current key (`current`); 404 when the fleet does not know it.
 */
export const GET: RequestHandler = ({ url }) => {
	const endpoint = url.searchParams.get('endpoint');
	const subscription = endpoint ? fleetPush().get(endpoint) : null;
	if (!subscription) return json({ error: 'Not subscribed' }, { status: 404 });
	// Read only: asking about a device must not make the fleet a key pair.
	return json({ events: subscription.events, current: subscription.vapid === fleetPush().keys()?.publicKey });
};

/**
 * Subscribe a device, or change which events it takes: `{ endpoint, keys: {
 * p256dh, auth }, events, vapid }`, `vapid` being the public key it subscribed
 * with (the fleet's current one when left out). The device goes on every
 * machine's list.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		endpoint?: unknown;
		keys?: { p256dh?: unknown; auth?: unknown };
		events?: Partial<Record<keyof PushEvents, unknown>>;
		vapid?: unknown;
	} | null;
	const endpoint = body?.endpoint;
	const p256dh = body?.keys?.p256dh;
	const auth = body?.keys?.auth;
	if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string') {
		return json({ error: 'Expected a push subscription: endpoint and keys' }, { status: 400 });
	}
	const record = fleetPush().save({
		endpoint,
		keys: { p256dh, auth },
		events: { needsYou: body?.events?.needsYou !== false, done: body?.events?.done !== false },
		vapid: typeof body?.vapid === 'string' ? body.vapid : vapidKeys().publicKey
	});
	return json({ events: record.events });
};

/** Forget a device on every machine: `{ endpoint }`. */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
	if (typeof body?.endpoint !== 'string') return json({ error: 'Expected an endpoint' }, { status: 400 });
	fleetPush().forget([body.endpoint]);
	return json({ ok: true });
};
