/**
 * Fleet preferences: what a person chose about the fleet, kept on the servers
 * and the same on every link and device (spec #92). Device preferences
 * (notification mode, sound, theme, panel width) stay in browser storage.
 *
 * Each preference is a key holding the last value written to it, stamped
 * with when and on which machine. Machines pass their whole set to each other
 * and keep, key by key, the later write, so the fleet converges whichever
 * order the sets arrive in. A key is never removed: clearing a preference
 * writes its default, which is itself a write that must win over older ones.
 *
 * Keys are small and many rather than one large value per kind, so two
 * machines folding two different projects at once both keep their fold.
 */

import { z } from "zod/v4";

/** One preference: its value, when it was written (ms, the writing server's clock), and on which machine. */
export const PrefEntrySchema = z.object({ value: z.unknown(), at: z.number().finite(), by: z.string() });

export type PrefEntry = z.infer<typeof PrefEntrySchema>;

export type FleetPrefs = Record<string, PrefEntry>;

/** The longest key accepted; a key carries a machine id and a path at most. */
export const MAX_KEY_LENGTH = 1024;

/** The filter on the sidebar's machines: 'all', or one machine's id. */
export const MACHINE_FILTER = "machine-filter";

/** The project rail's order, a list of project keys (`src/fleet-rail.ts`). */
export const RAIL_ORDER = "rail-order";

/** Whether a plugin, by its fleet key (`pluginKey()` in `src/fleet-plugins.ts`), is wanted only where it is installed. */
export function onlyHereKey(pluginKey: string): string {
  return `plugin:only-here:${pluginKey}`;
}

/**
 * Whether a session was settled by hand (spec #92): one key per session,
 * `settled:<machine id>:<session id>`, true while settled and false once
 * un-settled, so two machines settling two sessions at once both keep theirs.
 */
export function settledKey(machineId: string, sessionId: string): string {
  return `settled:${machineId}:${sessionId}`;
}

/**
 * Keys the servers keep among themselves: they spread from machine to machine
 * like any other, but a page is never sent them and cannot write them. The
 * Web Push key pair and the devices subscribed to it live here
 * (`src/fleet-push.ts`).
 */
export const SERVER_ONLY_PREFIX = "push:";

/**
 * The fleet's Web Push key pair. Unlike every other key, the first write
 * holds: the key every device subscribed with must not be replaced by one a
 * machine made later, so the earliest made is the one the fleet keeps.
 */
export const PUSH_VAPID = "push:vapid";

export function isServerOnlyKey(key: string): boolean {
  return key.startsWith(SERVER_ONLY_PREFIX);
}

/** Whether `a` was written after `b`; the machine id breaks a tie, so every machine picks the same one. */
export function isLater(a: PrefEntry, b: PrefEntry): boolean {
  return a.at !== b.at ? a.at > b.at : a.by > b.by;
}

/**
 * Whether `incoming` replaces `mine` under `key`: the later write, or the
 * earlier for `PUSH_VAPID`, where a pair that is no pair at all never holds
 * the key against one that is (it could otherwise never be replaced).
 */
export function replaces(key: string, incoming: PrefEntry, mine: PrefEntry): boolean {
  if (key !== PUSH_VAPID) return isLater(incoming, mine);
  const usable = isKeyPair(incoming.value);
  if (usable !== isKeyPair(mine.value)) return usable;
  return isLater(mine, incoming);
}

function isKeyPair(value: unknown): boolean {
  const pair = value as { publicKey?: unknown; privateKey?: unknown } | null;
  return typeof pair?.publicKey === "string" && pair.publicKey !== "" && typeof pair.privateKey === "string" && pair.privateKey !== "";
}

export function isPrefKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

/**
 * `current` with every entry of `incoming` that replaces its own (`replaces()`), and the
 * keys that changed. `incoming` is read as whatever another machine sent:
 * anything that is not a well-formed entry is skipped.
 */
export function mergePrefs(current: FleetPrefs, incoming: unknown): { prefs: FleetPrefs; changed: string[] } {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return { prefs: current, changed: [] };
  const changed: string[] = [];
  let prefs = current;
  for (const [key, raw] of Object.entries(incoming)) {
    const parsed = PrefEntrySchema.safeParse(raw);
    if (!isPrefKey(key) || !parsed.success) continue;
    const mine = prefs[key];
    if (mine && !replaces(key, parsed.data, mine)) continue;
    if (prefs === current) prefs = { ...current };
    prefs[key] = parsed.data;
    changed.push(key);
  }
  return { prefs, changed };
}
