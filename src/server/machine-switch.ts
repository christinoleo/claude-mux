/**
 * The one switch per machine for everything claude-mux does there on its own
 * (#219): the worker queue's starts, session and rule Triggers, the release
 * rule, live text and dashboard approvals. Off at first. Turning it off stops
 * new starts and removes both hooks; nothing already running is stopped.
 *
 * The state is `~/.claude-mux/machine-switch.json`. The two hooks keep their
 * own entries in `~/.claude/settings.json` (`hook-switch.ts`), which this
 * writes along with the file, and only a built server writes them. A dev
 * server reads the switch, and flips the file only when it polls GitHub under
 * a HOME of its own (`CLAUDE_MUX_EVENTS=1`), leaving the hooks alone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import type { HookWriter } from "./hook-switch.js";
import { followLiveTextPort, readLiveText, setLiveText } from "./live-text-switch.js";
import { followDialogAnswersPort, readDialogAnswers, setDialogAnswers } from "./dialog-switch.js";

/** What every part says while the switch is off. */
export const MACHINE_OFF = "Off on this machine";

const HOOKS = [
  { read: readLiveText, set: setLiveText, follow: followLiveTextPort },
  { read: readDialogAnswers, set: setDialogAnswers, follow: followDialogAnswersPort },
];

const switchPath = () => join(CLAUDE_MUX_DIR, "machine-switch.json");

/**
 * What the separate switches this one replaced said: the worker queue's own
 * (`enabled` in `worker-queue.json`) and the two hooks. Any of them on means on,
 * so a machine that had live text keeps it.
 */
function legacyOn(): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(CLAUDE_MUX_DIR, "worker-queue.json"), "utf-8")) as { settings?: { enabled?: unknown } };
    if (raw.settings?.enabled === true) return true;
  } catch {
    // No queue file: the queue was never switched on.
  }
  return HOOKS.some((h) => h.read({ dev: false }).enabled);
}

/** Whether the switch is on. The first read on a machine takes it over from the old switches and writes it down. */
export function machineOn(): boolean {
  try {
    const raw = JSON.parse(readFileSync(switchPath(), "utf-8")) as { on?: unknown };
    if (typeof raw.on === "boolean") return raw.on;
  } catch {
    // Missing or torn: decided again below.
  }
  const on = legacyOn();
  try {
    writeFileAtomic(switchPath(), JSON.stringify({ on }, null, 2));
  } catch {
    // Read again next time; the answer is the same.
  }
  return on;
}

/** A dev server may flip the file only under a HOME of its own, where it polls GitHub. */
function mayWrite(dev: boolean): boolean {
  return !dev || process.env.CLAUDE_MUX_EVENTS === "1";
}

export interface MachineSwitchState {
  on: boolean;
  /** Whether this server may turn it. */
  switchable: boolean;
}

export function readMachineSwitch({ dev }: Pick<HookWriter, "dev">): MachineSwitchState {
  return { on: machineOn(), switchable: mayWrite(dev) };
}

/**
 * Turn the switch. False when this server may not; throws when a file cannot be
 * written. The hooks go first, so a failure there leaves the switch as it was.
 */
export function setMachineSwitch(on: boolean, writer: HookWriter): boolean {
  if (!mayWrite(writer.dev)) return false;
  if (!writer.dev) for (const h of HOOKS) h.set(on, writer);
  writeFileAtomic(switchPath(), JSON.stringify({ on }, null, 2));
  return true;
}

/**
 * At startup, on a built server: the hooks agree with the switch. On, each is
 * added where it is missing and follows this server's port where it is there
 * (`hook-switch.ts` says when it may move). Off, any left behind is removed.
 * Never rejects.
 */
export async function followMachineSwitch(writer: HookWriter, answers?: (port: number) => Promise<boolean>): Promise<void> {
  if (writer.dev) return;
  try {
    const on = machineOn();
    for (const h of HOOKS) {
      const installed = h.read(writer).enabled;
      if (on && installed) await h.follow(writer, answers);
      else if (on !== installed) h.set(on, writer);
    }
  } catch (err) {
    console.warn(`[machine-switch] could not bring the hooks in line: ${String(err)}`);
  }
}
