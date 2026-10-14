/**
 * Kept apart from `fleet.ts`, which reaches the scanner and the filesystem,
 * so the page can import it.
 */

import type { FleetMachine } from "./fleet.js";

/** How many of the machines asked a fleet total covers, so the figure can say when it is short. */
export function spendCoverage(machines: readonly FleetMachine[]): { answered: number; total: number } {
  return { answered: machines.filter((m) => m.ok).length, total: machines.length };
}
