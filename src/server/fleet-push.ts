/**
 * This machine's hold on the fleet's Web Push key pair and subscribed devices
 * (`src/fleet-push.ts`), read and written through its fleet preferences, so
 * a device subscribed here is on every machine's list within a broadcast and
 * one forgotten anywhere is forgotten everywhere.
 */

import { readFileSync, statSync } from "node:fs";
import { PUSH_VAPID } from "../fleet-prefs.js";
import {
  fleetVapid,
  subscriptionIn,
  subscriptionKey,
  subscriptionsIn,
  subscriptionValue,
  type PushEvents,
  type PushSubscriptionRecord,
  type VapidKeys,
} from "../fleet-push.js";
import type { FleetPrefsStore } from "./fleet-prefs.js";

export class FleetPush {
  constructor(
    private readonly prefs: FleetPrefsStore,
    private readonly selfId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The fleet's key pair, or null while no machine has made one. */
  keys(): VapidKeys | null {
    return fleetVapid(this.prefs.all());
  }

  /**
   * Put forward a key pair made at `at`. The fleet keeps the earliest made,
   * so this one stands only if no machine holds an older one.
   */
  offerKeys(keys: VapidKeys, at: number): void {
    this.prefs.merge({ [PUSH_VAPID]: { value: keys, at, by: this.selfId } });
  }

  /** The fleet's key pair, made now by `generate` when no machine has one yet. */
  ensureKeys(generate: () => VapidKeys): VapidKeys {
    const held = this.keys();
    if (held) return held;
    this.offerKeys(generate(), this.now());
    return this.keys()!;
  }

  /** The devices a push signed with the fleet's key reaches. */
  subscriptions(): PushSubscriptionRecord[] {
    const keys = this.keys();
    return keys ? subscriptionsIn(this.prefs.all(), keys.publicKey) : [];
  }

  /** One device, under whichever key it subscribed, or null. */
  get(endpoint: string): PushSubscriptionRecord | null {
    return subscriptionIn(this.prefs.all(), endpoint);
  }

  /** Add a device, or replace its keys and events if it subscribed before. */
  save(subscription: Omit<PushSubscriptionRecord, "created_at">): PushSubscriptionRecord {
    const record: PushSubscriptionRecord = {
      ...subscription,
      events: { needsYou: subscription.events.needsYou, done: subscription.events.done },
      created_at: this.get(subscription.endpoint)?.created_at ?? this.now(),
    };
    this.prefs.set(subscriptionKey(record.endpoint), subscriptionValue(record));
    return record;
  }

  /** Change which events a device takes; null when it is not subscribed. */
  setEvents(endpoint: string, events: PushEvents): PushSubscriptionRecord | null {
    const record = this.get(endpoint);
    return record ? this.save({ ...record, events }) : null;
  }

  /** Forget the given devices on every machine. Returns how many were there to forget. */
  forget(endpoints: Iterable<string>): number {
    let forgotten = 0;
    for (const endpoint of new Set(endpoints)) {
      if (!this.get(endpoint)) continue;
      this.prefs.set(subscriptionKey(endpoint), null);
      forgotten++;
    }
    return forgotten;
  }

  /**
   * Bring in what this machine kept before push spread across the fleet: its
   * own key pair in `vapid.json`, put forward with the time the file was
   * written, and the devices in `push-subscriptions.json`, bound to that key.
   * A device the fleet already knows of, or forgot, is left as the fleet has it.
   */
  importLocal(vapidPath: string, subscriptionsPath: string): void {
    const local = readLocalKeys(vapidPath);
    if (!local) return;
    this.offerKeys(local.keys, local.at);
    for (const old of readLocalSubscriptions(subscriptionsPath)) {
      if (subscriptionKey(old.endpoint) in this.prefs.all()) continue;
      this.prefs.set(subscriptionKey(old.endpoint), subscriptionValue({ ...old, vapid: local.keys.publicKey }));
    }
  }
}

function readLocalKeys(path: string): { keys: VapidKeys; at: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<VapidKeys>;
    if (!parsed.publicKey || !parsed.privateKey) return null;
    return { keys: { publicKey: parsed.publicKey, privateKey: parsed.privateKey }, at: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function readLocalSubscriptions(path: string): Omit<PushSubscriptionRecord, "vapid">[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (v): v is Omit<PushSubscriptionRecord, "vapid"> =>
      typeof v?.endpoint === "string" &&
      typeof v.keys?.p256dh === "string" &&
      typeof v.keys?.auth === "string" &&
      typeof v.events?.needsYou === "boolean" &&
      typeof v.events?.done === "boolean" &&
      typeof v.created_at === "number",
  );
}
