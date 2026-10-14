/**
 * The drawer's project rail (spec #92, "The project rail").
 *
 * The rail holds every project in the fleet in an order the person sets by
 * dragging, kept as the fleet preference `RAIL_ORDER` so every link and
 * device draws the same rail. Nothing reorders it by itself: activity shows
 * as badges, and the only change the rail makes on its own is to put a
 * project the saved order has never seen at the top, where it is noticed.
 *
 * The saved order is a list of project keys (`projectKey()` in
 * `src/fleet-projects.ts`). A key that is not on the rail right now stays in
 * it, so a project whose machine is away comes back to the place it had.
 */

/** Read what the preference holds as a list of keys; anything else is no order at all. */
function savedKeys(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter((k): k is string => typeof k === "string");
}

/**
 * The rail's order for the projects in `keys`: those the saved order has
 * never seen first, in the order given, then the rest in the saved order.
 */
export function railOrder(saved: unknown, keys: readonly string[]): string[] {
  const known = savedKeys(saved);
  const present = new Set(keys);
  const seen = new Set(known);
  return [...keys.filter((k) => !seen.has(k)), ...known.filter((k) => present.has(k))];
}

/**
 * The order to save after `key` is dropped before `before` (at the end when
 * null) on the rail as it is drawn (`shown`). Keys saved earlier but not
 * drawn now are kept, after the rest.
 */
export function moveTile(saved: unknown, shown: readonly string[], key: string, before: string | null): string[] {
  const drawn = new Set(shown);
  if (key === before) return [...shown, ...savedKeys(saved).filter((k) => !drawn.has(k))];
  const order = shown.filter((k) => k !== key);
  const at = before === null ? -1 : order.indexOf(before);
  order.splice(at < 0 ? order.length : at, 0, key);
  const kept = new Set(order);
  return [...order, ...savedKeys(saved).filter((k) => !kept.has(k))];
}

/**
 * Whether any of a thing's fields holds what was typed, ignoring case. A
 * leading `#` is dropped, so `#100` finds the worker on issue 100.
 */
export function matchesQuery(query: string, fields: readonly (string | number | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  return fields.some((f) => f != null && String(f).toLowerCase().includes(q));
}

/**
 * The colours a machine's letter is drawn in. None is amber, emerald,
 * violet, teal or red, which states, workers and subagents already own,
 * and none is a project hue (`PROJECT_HUES`).
 */
export const MACHINE_COLORS = ["#7dd3fc", "#f0abfc", "#bef264", "#fda4af", "#cbd5e1"] as const;

export interface MachineMark {
  /** One letter, or two where machines share their first. */
  letter: string;
  color: string;
  /** The machine's name, for a tooltip. */
  name: string;
}

/**
 * Each machine's letter and colour. Colours go by the sorted ids, so they
 * are the same on every link and device, and distinct while there are no
 * more machines than colours.
 */
export function machineMarks(machines: readonly { id: string; name: string }[]): Map<string, MachineMark> {
  const first = (name: string) => (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  const counts = new Map<string, number>();
  for (const m of machines) counts.set(first(m.name), (counts.get(first(m.name)) ?? 0) + 1);
  const ids = [...new Set(machines.map((m) => m.id))].sort();
  const marks = new Map<string, MachineMark>();
  for (const m of machines) {
    const one = first(m.name);
    const two = m.name.replace(/[^a-z0-9]/gi, "").slice(0, 2);
    const letter = (counts.get(one)! > 1 && two.length === 2 ? one + two[1].toLowerCase() : one);
    marks.set(m.id, { name: m.name, letter, color: MACHINE_COLORS[ids.indexOf(m.id) % MACHINE_COLORS.length] });
  }
  return marks;
}
