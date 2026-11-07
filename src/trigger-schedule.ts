/**
 * A clock Trigger's schedule (`src/server/triggers.ts`), kept apart from
 * `node:fs` so the Triggers screen can import it.
 */

export const UNITS = ["second", "minute", "hour", "day"] as const;
export type Unit = (typeof UNITS)[number];
export const UNIT_MS: Record<Unit, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** `Date.getDay()` order, Sunday 0. */
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type Schedule =
  | { type: "every"; n: number; unit: Unit }
  /** Days as `Date.getDay()` numbers, Sunday 0; the time is this machine's local time. */
  | { type: "weekly"; days: number[]; time: string }
  | { type: "once"; at: number };
