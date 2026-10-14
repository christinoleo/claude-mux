/**
 * What machines in a fleet must agree on to act on each other's sessions.
 *
 * `PROTOCOL` is what this build speaks, and every machine reports its own in
 * its health check. `MIN_PROTOCOL` is the oldest a machine may speak for this
 * one to relay a page's actions to it: below it, the relay refuses with a
 * notice naming the machine (`protocolRefusal()`), rather than letting a
 * request reach routes that answer differently or not at all. A machine whose
 * health check answers without a protocol predates all of this and counts as
 * 0. Raise both when a change to what one machine asks of another would break
 * an older peer.
 *
 * 1: the fleet relay, fleet state and preferences, and `/api/update`.
 */

export const PROTOCOL = 1;
export const MIN_PROTOCOL = 1;

/**
 * The owner's paths a machine below the minimum still answers through the
 * relay: how it is told apart, and how it is brought up to date.
 */
const ALWAYS_RELAYED = new Set(["/api/health", "/api/update"]);

export interface MachineProtocol {
  hostname: string;
  version: string | null;
  /** Null while unknown (never heard from), which refuses nothing. */
  protocol: number | null;
}

/** The protocol a health check reports: its own, 0 for one too old to say. */
export function protocolOf(health: { protocol?: unknown }): number {
  return typeof health.protocol === "number" && Number.isFinite(health.protocol) ? health.protocol : 0;
}

/** Whether a machine is known to speak less than this one needs. */
export function belowMinimum(protocol: number | null | undefined): boolean {
  return typeof protocol === "number" && protocol < MIN_PROTOCOL;
}

/** Why nothing may be done on a machine too old for this one, or null when it is not. */
export function protocolRefusal(machine: MachineProtocol): string | null {
  if (!belowMinimum(machine.protocol)) return null;
  const name = machine.hostname || "This machine";
  const runs = machine.version ? `claude-mux ${machine.version}` : "an older claude-mux";
  return `${name} runs ${runs}, too old to be reached from here; update ${machine.hostname || "it"} first`;
}

/** Whether the relay refuses `path` on a machine for its protocol, and with what notice. */
export function relayRefusal(machine: MachineProtocol | null, path: string): string | null {
  if (!machine || ALWAYS_RELAYED.has(path)) return null;
  return protocolRefusal(machine);
}
