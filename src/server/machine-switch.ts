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
import { enabledProjects } from "../db/event-map-json.js";
import { followLiveTextPort, readLiveText, setLiveText } from "./live-text-switch.js";
import { followDialogAnswersPort, readDialogAnswers, setDialogAnswers } from "./dialog-switch.js";

/** The repo the release rule releases; `github-events.ts` imports this module, so it is spelled here too. */
const RELEASE_REPO = "christinoleo/claude-mux";

/** What every part says while the switch is off. */
export const MACHINE_OFF = "Off on this machine";

const HOOKS = [
  { read: readLiveText, set: setLiveText, follow: followLiveTextPort },
  { read: readDialogAnswers, set: setDialogAnswers, follow: followDialogAnswersPort },
];

const switchPath = () => join(CLAUDE_MUX_DIR, "machine-switch.json");

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * What the machine did on its own before this switch: the worker queue's own
 * switch (`enabled` in `worker-queue.json`), either hook, a clock Trigger not
 * paused (Triggers had no switch, so one set up ran), or claude-mux's pushes
 * given to the release rule. Any of them means on, so a machine that had live
 * text keeps it and one that ran Triggers or released goes on doing so.
 */
function legacyOn(): boolean {
  const queue = readJson(join(CLAUDE_MUX_DIR, "worker-queue.json")) as { settings?: { enabled?: unknown } } | null;
  if (queue?.settings?.enabled === true) return true;
  if (HOOKS.some((h) => h.read({ dev: false }).enabled)) return true;
  const triggers = readJson(join(CLAUDE_MUX_DIR, "triggers.json")) as { triggers?: { paused?: unknown }[] } | null;
  if (Array.isArray(triggers?.triggers) && triggers.triggers.some((t) => t && t.paused !== true)) return true;
  return enabledProjects().get(RELEASE_REPO)?.events.push === "rule";
}

/** Whether the switch is on. A machine with no switch file yet answers what its old switches said (`settleMachineSwitch()`). */
export function machineOn(): boolean {
  const raw = readJson(switchPath()) as { on?: unknown } | null;
  return typeof raw?.on === "boolean" ? raw.on : legacyOn();
}

/**
 * At startup, on a server that runs the queue, before anything rewrites the
 * old switches' files: write down what they said, once. Never throws.
 */
export function settleMachineSwitch({ dev }: Pick<HookWriter, "dev">): void {
  if (!mayWrite(dev)) return;
  const raw = readJson(switchPath()) as { on?: unknown } | null;
  if (typeof raw?.on === "boolean") return;
  try {
    writeFileAtomic(switchPath(), JSON.stringify({ on: legacyOn() }, null, 2));
  } catch (err) {
    console.warn(`[machine-switch] could not write the switch: ${String(err)}`);
  }
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
  if (!writer.dev) {
    const before = HOOKS.map((h) => h.read(writer).enabled);
    try {
      for (const h of HOOKS) h.set(on, writer);
    } catch (err) {
      // One hook may be changed already: put them back as they were, as far as the file lets.
      HOOKS.forEach((h, i) => {
        try {
          h.set(before[i], writer);
        } catch {
          // The same failure; nothing more to do.
        }
      });
      throw err;
    }
  }
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
