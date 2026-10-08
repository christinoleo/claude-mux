import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import webpush from 'web-push';
import { getSessionsDir } from '$shared/db/index.js';
import { startPushMonitor, type PushMessage } from '$shared/server/push.js';
import type { PushSubscriptionRecord } from '$shared/db/index.js';
import { writeFileAtomic } from '$shared/utils/atomic-write.js';

/**
 * Who sends the pushes, as the push services see it. Apple refuses a subject
 * that is not a real `mailto:` or `https:` address, so this is the project's
 * home rather than anything on the local machine.
 */
const VAPID_SUBJECT = 'https://github.com/christinoleo/claude-mux';

/** How long a push service holds a message for a device that is offline. */
const TTL_SECONDS = 60 * 60;

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

let keys: VapidKeys | null = null;

/**
 * The server's VAPID key pair, made once and kept in `~/.claude-mux/vapid.json`.
 * Every subscription is bound to the public key, so a new pair would orphan
 * every device that subscribed under the old one.
 */
export function vapidKeys(): VapidKeys {
	if (keys) return keys;
	const path = join(dirname(getSessionsDir()), 'vapid.json');
	let raw: string | null = null;
	try {
		raw = readFileSync(path, 'utf-8');
	} catch (err) {
		// Missing is the first time anyone asked for push. Anything else (a
		// permission problem) must not be papered over with a new pair.
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	if (raw !== null) {
		const parsed = JSON.parse(raw) as Partial<VapidKeys>;
		if (!parsed.publicKey || !parsed.privateKey) throw new Error(`${path} holds no VAPID key pair`);
		keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
		return keys;
	}
	keys = webpush.generateVAPIDKeys();
	writeFileAtomic(path, JSON.stringify(keys, null, 2), 0o600);
	return keys;
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

type GlobalWithPush = typeof globalThis & { __claudeMuxPushMonitor?: () => void };

/** Start the monitor once per process; dev reloads this module, so the guard lives on globalThis. */
export function ensurePushMonitor(): void {
	const g = globalThis as GlobalWithPush;
	g.__claudeMuxPushMonitor ??= startPushMonitor(sendPush);
}
