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

/** Whether a machine's group in the sidebar is folded. */
export function machineFoldKey(machineId: string): string {
  return `fold:machine:${machineId}`;
}

/** Whether a project's card on a machine is folded. */
export function projectFoldKey(machineId: string, cwd: string): string {
  return `fold:project:${machineId}:${cwd}`;
}

/** Whether `a` was written after `b`; the machine id breaks a tie, so every machine picks the same one. */
export function isLater(a: PrefEntry, b: PrefEntry): boolean {
  return a.at !== b.at ? a.at > b.at : a.by > b.by;
}

export function isPrefKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

/**
 * `current` with every entry of `incoming` that was written later, and the
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
    if (mine && !isLater(parsed.data, mine)) continue;
    if (prefs === current) prefs = { ...current };
    prefs[key] = parsed.data;
    changed.push(key);
  }
  return { prefs, changed };
}
