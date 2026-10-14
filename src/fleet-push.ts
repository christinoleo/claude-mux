/**
 * Web Push across the fleet (spec #92, "Push"): one key pair and one list of
 * subscribed devices, kept in the fleet preferences so they spread from
 * machine to machine the way the rail's order does, under keys a page never
 * sees (`SERVER_ONLY_PREFIX`).
 *
 * The machine that owns a session sends its pushes to every device on the
 * list, whichever machine the device subscribed through, so each event leaves
 * once. The key pair is the first one made (`PUSH_VAPID` keeps the earliest
 * write): every machine adopts it, and a device subscribed under another key
 * is passed over until its page subscribes it again under this one.
 */

import { z } from "zod/v4";
import { PUSH_VAPID, type FleetPrefs } from "./fleet-prefs.js";

export interface PushEvents {
  /** A session started waiting on a person: a question or an approval. */
  needsYou: boolean;
  /** A session finished its turn. */
  done: boolean;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  events: PushEvents;
  created_at: number;
  /** The public key the device subscribed with; only a push signed with it reaches the device. */
  vapid: string;
}

const VapidKeysSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });

export type VapidKeys = z.infer<typeof VapidKeysSchema>;

const SubscriptionValueSchema = z.object({
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  events: z.object({ needsYou: z.boolean(), done: z.boolean() }),
  created_at: z.number(),
  vapid: z.string(),
});

const SUBSCRIPTION_PREFIX = "push:sub:";

/** The key a device's subscription is kept under: its endpoint, which is what identifies it. */
export function subscriptionKey(endpoint: string): string {
  return SUBSCRIPTION_PREFIX + endpoint;
}

/** What is kept under a device's key; a device forgotten keeps its key, holding null. */
export function subscriptionValue(record: PushSubscriptionRecord): Omit<PushSubscriptionRecord, "endpoint"> {
  return { keys: record.keys, events: record.events, created_at: record.created_at, vapid: record.vapid };
}

/** The fleet's key pair, or null while no machine has made one. */
export function fleetVapid(prefs: FleetPrefs): VapidKeys | null {
  const parsed = VapidKeysSchema.safeParse(prefs[PUSH_VAPID]?.value);
  return parsed.success ? parsed.data : null;
}

/** One device's subscription, whichever key it was made under, or null. */
export function subscriptionIn(prefs: FleetPrefs, endpoint: string): PushSubscriptionRecord | null {
  const parsed = SubscriptionValueSchema.safeParse(prefs[subscriptionKey(endpoint)]?.value);
  return parsed.success ? { endpoint, ...parsed.data } : null;
}

/** Every device subscribed under `publicKey`: the ones a push signed with it can reach. */
export function subscriptionsIn(prefs: FleetPrefs, publicKey: string): PushSubscriptionRecord[] {
  return Object.keys(prefs)
    .filter((key) => key.startsWith(SUBSCRIPTION_PREFIX))
    .map((key) => subscriptionIn(prefs, key.slice(SUBSCRIPTION_PREFIX.length)))
    .filter((s): s is PushSubscriptionRecord => s !== null && s.vapid === publicKey);
}
