/**
 * The devices that asked for Web Push, kept in `~/.claude-mux/push-subscriptions.json`.
 *
 * A subscription is what the browser's push service handed the device: an
 * endpoint URL and the two keys a message is encrypted with. Each one carries
 * the events its device wants, so a phone can take "needs you" alone while a
 * tablet takes both. The endpoint is the identity: subscribing again from the
 * same device replaces its entry.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { getSessionsDir } from "./sessions-json.js";
import { writeFileAtomic } from "../utils/atomic-write.js";

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
}

let subscriptionsPath: string | null = null;

/** Overridable for tests; null means "next to the sessions directory". */
export function setPushSubscriptionsPath(path: string | null): void {
  subscriptionsPath = path;
}

function resolvePath(): string {
  return subscriptionsPath ?? join(dirname(getSessionsDir()), "push-subscriptions.json");
}

function isRecord(value: unknown): value is PushSubscriptionRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PushSubscriptionRecord>;
  return (
    typeof v.endpoint === "string" &&
    typeof v.keys?.p256dh === "string" &&
    typeof v.keys?.auth === "string" &&
    typeof v.events?.needsYou === "boolean" &&
    typeof v.events?.done === "boolean"
  );
}

export function getPushSubscriptions(): PushSubscriptionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(resolvePath(), "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function getPushSubscription(endpoint: string): PushSubscriptionRecord | null {
  return getPushSubscriptions().find((s) => s.endpoint === endpoint) ?? null;
}

function write(subscriptions: PushSubscriptionRecord[]): void {
  writeFileAtomic(resolvePath(), JSON.stringify(subscriptions, null, 2));
}

/** Add a device, or replace its keys and events if it subscribed before. */
export function savePushSubscription(
  subscription: Pick<PushSubscriptionRecord, "endpoint" | "keys" | "events">,
): PushSubscriptionRecord {
  const all = getPushSubscriptions();
  const prior = all.find((s) => s.endpoint === subscription.endpoint);
  const record: PushSubscriptionRecord = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    events: { needsYou: subscription.events.needsYou, done: subscription.events.done },
    created_at: prior?.created_at ?? Date.now(),
  };
  write([...all.filter((s) => s.endpoint !== subscription.endpoint), record]);
  return record;
}

/** Forget the given devices. Returns how many were there to forget. */
export function removePushSubscriptions(endpoints: Iterable<string>): number {
  const gone = new Set(endpoints);
  const all = getPushSubscriptions();
  const kept = all.filter((s) => !gone.has(s.endpoint));
  if (kept.length !== all.length) write(kept);
  return all.length - kept.length;
}
