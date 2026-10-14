import { dirname, join } from 'path';
import webpush from 'web-push';
import { getSessionsDir } from '$shared/db/index.js';
import { startPushMonitor, type PushMessage } from '$shared/server/push.js';
import { FleetPush } from '$shared/server/fleet-push.js';
import type { PushSubscriptionRecord, VapidKeys } from '$shared/fleet-push.js';
import { MACHINE_ID } from '$lib/server/instance';
import { selfName } from '$lib/server/discover';
import { ensureFleetPrefs } from '$lib/server/fleet';

/**
 * Who sends the pushes, as the push services see it. Apple refuses a subject
 * that is not a real `mailto:` or `https:` address, so this is the project's
 * home rather than anything on the local machine.
 */
const VAPID_SUBJECT = 'https://github.com/christinoleo/claude-mux';

/** How long a push service holds a message for a device that is offline. */
const TTL_SECONDS = 60 * 60;

type GlobalWithPush = typeof globalThis & { __claudeMuxPushMonitor?: () => void; __claudeMuxFleetPush?: FleetPush };

/**
 * The fleet's push keys and devices (`src/server/fleet-push.ts`), kept in the
 * fleet preferences. On first use it brings in what this machine kept before
 * push spread across the fleet: its own key pair in `~/.claude-mux/vapid.json`
 * and its devices in `push-subscriptions.json`.
 */
export function fleetPush(): FleetPush {
	const g = globalThis as GlobalWithPush;
	if (g.__claudeMuxFleetPush) return g.__claudeMuxFleetPush;
	const push = new FleetPush(ensureFleetPrefs(), MACHINE_ID);
	const dir = dirname(getSessionsDir());
	push.importLocal(join(dir, 'vapid.json'), join(dir, 'push-subscriptions.json'));
	g.__claudeMuxFleetPush = push;
	return push;
}

/**
 * The fleet's VAPID key pair, made here when no machine has one yet. Every
 * subscription is bound to the public key, so the fleet keeps the first pair
 * made (`PUSH_VAPID`), and a page subscribes its device again when the key
 * it holds is not this one.
 */
export function vapidKeys(): VapidKeys {
	return fleetPush().ensureKeys(() => webpush.generateVAPIDKeys());
}

export function sendPush(subscription: PushSubscriptionRecord, message: PushMessage) {
	const { publicKey, privateKey } = vapidKeys();
	return webpush.sendNotification(subscription, JSON.stringify(message), {
		vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
		TTL: TTL_SECONDS,
		// A finished turn can wait for the phone's next wake; a waiting session cannot.
		urgency: message.kind === 'completion' ? 'normal' : 'high'
	});
}

/** Start the monitor once per process; dev reloads this module, so the guard lives on globalThis. */
export function ensurePushMonitor(): void {
	const g = globalThis as GlobalWithPush;
	if (g.__claudeMuxPushMonitor) return;
	const push = fleetPush();
	g.__claudeMuxPushMonitor = startPushMonitor(
		sendPush,
		{ subscriptions: () => push.subscriptions(), forget: (endpoints) => push.forget(endpoints) },
		selfName
	);
}
