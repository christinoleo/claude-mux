/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * The service worker exists for Web Push alone: it shows what the server
 * pushes and opens the session when the notification is tapped. It has no
 * fetch handler and caches nothing, so the app is always what the server
 * serves now — claude-mux is useless offline anyway.
 */

import type { PushMessage } from '$shared/server/push.js';

const sw = self as unknown as ServiceWorkerGlobalScope;

// One worker, taking over at once: there is no cache for an old one to keep consistent.
sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('push', (event) => {
	let message: PushMessage;
	try {
		message = event.data?.json() as PushMessage;
	} catch {
		return;
	}
	if (!message?.title) return;
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			// A window in front alerts for itself (a toast, or nothing for the
			// session on screen), so the push would only say it twice.
			if (windows.some((w) => w.focused)) return;
			await sw.registration.showNotification(message.title, {
				body: message.body,
				tag: message.tag,
				icon: '/icon-192.png',
				badge: '/icon-192.png',
				data: { url: message.url }
			});
		})()
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = (event.notification.data as { url?: string } | null)?.url ?? '/';
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = windows.find((w) => w.focused) ?? windows[0];
			if (!open) {
				await sw.clients.openWindow(url);
				return;
			}
			// The page routes itself (see NotificationCoordinator), which keeps its
			// socket and state instead of reloading the app.
			open.postMessage({ type: 'open', url });
			await open.focus();
		})()
	);
});
