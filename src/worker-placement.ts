/**
 * Where a project's workers may run (#185), as the fleet preferences hold it
 * (`src/fleet-prefs.ts`), so every machine reads the same answer.
 *
 * - `placement:<owner/name>` lists the machines a project's workers may run
 *   on, by name. Unset or empty, any machine holding its checkout may.
 * - `queue:exclusive` lists the machines whose projects run only there. A
 *   machine on it keeps every project it holds: no other machine starts a
 *   worker for one, even with a checkout of its own. Unset, it is `engage`,
 *   the client's machine, whose projects are developed and run only there.
 *
 * Kept apart from the server so the page can import it.
 */

export const EXCLUSIVE_KEY = "queue:exclusive";
export const DEFAULT_EXCLUSIVE = ["engage"];

export function placementKey(repo: string): string {
  return `placement:${repo.toLowerCase()}`;
}

/** A machine's name as placement compares it: its first DNS label, lower case. */
export function placeName(hostname: string): string {
  return hostname.trim().toLowerCase().split(".")[0];
}

/** A list of machine names out of a preference's value; null when it holds none. */
export function nameList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map(placeName);
  return names.length > 0 ? [...new Set(names)] : null;
}

/** The machines that keep their projects: the preference when it was ever set (an empty list included), else the default. */
export function exclusiveList(value: unknown): string[] {
  return Array.isArray(value) ? (nameList(value) ?? []) : DEFAULT_EXCLUSIVE;
}
