/**
 * This device's Web Push subscription, as the browser and the fleet each
 * hold it. The browser's PushManager owns the subscription itself; the fleet
 * keeps the events it should carry, on every machine (`src/fleet-push.ts`),
 * so a device subscribed through one machine hears all of them.
 */
import type { PushEvents } from '$shared/fleet-push.js';

export type { PushEvents };

/** Why push cannot work here, or null when it can. */
export function pushUnavailable(): string | null {
	if (!window.isSecureContext) return 'Push needs HTTPS. Open claude-mux through tailscale serve.';
	const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
	const standalone = window.matchMedia('(display-mode: standalone)').matches;
	if (ios && !standalone) return 'On iPhone and iPad, add claude-mux to the Home Screen (Share → Add to Home Screen) and open it from there.';
	if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
		return 'This browser has no Web Push.';
	}
	return null;
}

/**
 * The running service worker. SvelteKit registers it on load and `ready`
 * waits for that, forever if registration failed, so it gets a deadline.
 */
function worker(): Promise<ServiceWorkerRegistration> {
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('The service worker did not start. Reload the page and try again.')), 10_000)
		)
	]);
}

/** The browser's subscription for this device, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	return (await worker()).pushManager.getSubscription();
}

/**
 * The events the fleet sends this device, and whether it subscribed under the
 * fleet's current key; null when the fleet does not know it.
 */
export async function serverEvents(
	subscription: PushSubscription
): Promise<{ events: PushEvents; current: boolean } | null> {
	const res = await fetch(`/api/push/subscription?endpoint=${encodeURIComponent(subscription.endpoint)}`);
	if (!res.ok) return null;
	return (await res.json()) as { events: PushEvents; current: boolean };
}

function toKey(base64url: string): Uint8Array<ArrayBuffer> {
	const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Call a push route with a JSON body; rejects with the server's own error when it refuses. */
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
	if (!res.ok) throw new Error(data?.error ?? `The server answered ${res.status}`);
	return data as T;
}

/** Tell the fleet about the subscription and the key it was made with, or which events it now takes. */
export async function saveEvents(subscription: PushSubscription, events: PushEvents): Promise<PushEvents> {
	const bound = subscription.options.applicationServerKey;
	const vapid = bound ? toBase64Url(new Uint8Array(bound)) : undefined;
	return (await api<{ events: PushEvents }>('/api/push/subscription', 'POST', { ...subscription.toJSON(), events, vapid }))
		.events;
}

function toBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Ask for permission, subscribe with the fleet's key and register the
 * device. A subscription made under another key (the fleet adopted an older
 * machine's) is replaced, since no machine could reach it.
 */
export async function subscribe(events: PushEvents): Promise<PushSubscription> {
	// The key is fetched while the permission prompt is up; neither waits on the other.
	const vapid = api<{ publicKey: string }>('/api/push');
	vapid.catch(() => {});
	if ((await Notification.requestPermission()) !== 'granted') {
		throw new Error('Notifications are blocked. Allow them in the browser’s site settings, then try again.');
	}
	const key = toKey((await vapid).publicKey);
	const manager = (await worker()).pushManager;
	let subscription = await manager.getSubscription();
	const bound = subscription?.options.applicationServerKey;
	if (subscription && (!bound || !sameBytes(new Uint8Array(bound), key))) {
		await unsubscribe(subscription);
		subscription = null;
	}
	subscription ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	await saveEvents(subscription, events);
	return subscription;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function unsubscribe(subscription: PushSubscription): Promise<void> {
	await api('/api/push/subscription', 'DELETE', { endpoint: subscription.endpoint }).catch(() => {});
	await subscription.unsubscribe();
}

export async function sendTestPush(subscription: PushSubscription): Promise<void> {
	await api('/api/push/test', 'POST', { endpoint: subscription.endpoint });
}

/**
 * Keep this device's subscription on the fleet's key, without asking: a
 * device subscribed under a key the fleet no longer uses (its machine's own,
 * before the fleet adopted an older one) is subscribed again under the
 * fleet's, taking the same events. Does nothing where push is off.
 */
export function keepSubscriptionCurrent(): Promise<void> {
	// Callers that overlap (the coordinator and the settings) share one run.
	return (renewing ??= renew().finally(() => {
		renewing = null;
	}));
}

let renewing: Promise<void> | null = null;

async function renew(): Promise<void> {
	if (pushUnavailable() || Notification.permission !== 'granted') return;
	const subscription = await currentSubscription();
	if (!subscription) return;
	const known = await serverEvents(subscription);
	if (known?.current) return;
	// A device the fleet forgot (gone, or turned off elsewhere) stays off.
	if (!known) return;
	await subscribe(known.events);
}
