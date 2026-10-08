/**
 * This device's Web Push subscription, as the browser and the server each
 * hold it. The browser's PushManager owns the subscription itself; the server
 * keeps the events it should carry.
 */
import type { PushEvents } from '$shared/db/index.js';

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

/** The events the server sends this device, or null when the server does not know it. */
export async function serverEvents(subscription: PushSubscription): Promise<PushEvents | null> {
	const res = await fetch(`/api/push/subscription?endpoint=${encodeURIComponent(subscription.endpoint)}`);
	if (!res.ok) return null;
	return ((await res.json()) as { events: PushEvents }).events;
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

/** Tell the server about the subscription, or which events it now takes. */
export async function saveEvents(subscription: PushSubscription, events: PushEvents): Promise<PushEvents> {
	return (await api<{ events: PushEvents }>('/api/push/subscription', 'POST', { ...subscription.toJSON(), events })).events;
}

/**
 * Ask for permission, subscribe with the server's key and register the
 * device. A subscription made under another key (the server's keys were
 * remade) is replaced, since the server could never reach it.
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
		await subscription.unsubscribe();
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
