/**
 * The switch that turns live text on for this machine: the `MessageDisplay`
 * hook being in `~/.claude/settings.json` is what "on" means, so there is no
 * second copy of the state to disagree with what sessions actually read, and
 * `setup` keeps the switch just by leaving the entry alone.
 *
 * Only the production server writes. A dev server shares this file with every
 * real session on the machine and with a port that would be gone by morning,
 * so it can read the switch and nothing more (`LiveTextWriter.dev`).
 */

import { readClaudeSettings, saveClaudeSettings } from "../setup/hooks.js";
import { liveTextHookPort, withLiveTextHook, withoutLiveTextHook } from "../setup/live-text-hook.js";

interface LiveTextWriter {
  dev: boolean;
  port: number;
}

export function readLiveText({ dev }: Pick<LiveTextWriter, "dev">): { enabled: boolean; switchable: boolean } {
  let enabled = false;
  try {
    enabled = liveTextHookPort(readClaudeSettings()) !== null;
  } catch {
    // Unreadable settings hold no hook a session could run either.
  }
  return { enabled, switchable: !dev };
}

/** Turn the switch. False when this server may not; throws when the settings cannot be read or written. */
export function setLiveText(enabled: boolean, { dev, port }: LiveTextWriter): boolean {
  if (dev) return false;
  const current = readClaudeSettings();
  // Every session on the machine rereads the file, so a switch already there writes nothing.
  if (liveTextHookPort(current) === (enabled ? port : null)) return true;
  saveClaudeSettings(enabled ? withLiveTextHook(current, port) : withoutLiveTextHook(current));
  return true;
}

/** Whether a claude-mux server answers on this machine's `port`. */
async function serverAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok && ((await res.json()) as { app?: unknown }).app === "claude-mux";
  } catch {
    return false;
  }
}

/**
 * At startup: a switch left on keeps pointing at this server when it comes up
 * on another port. Not while a server still answers on the old one, because a
 * second built server beside the real one (trying out a build) must not take
 * every session's live text with it and leave a dead port when it exits. A
 * machine with the switch off is left as it is. Never rejects, since nothing
 * about this is worth a server that will not start.
 */
export async function followLiveTextPort(
  { dev, port }: LiveTextWriter,
  answers: (port: number) => Promise<boolean> = serverAnswers
): Promise<void> {
  if (dev) return;
  try {
    const installed = liveTextHookPort(readClaudeSettings());
    if (installed === null || installed === port || (await answers(installed))) return;
    saveClaudeSettings(withLiveTextHook(readClaudeSettings(), port));
  } catch (err) {
    console.warn(`[live-text] could not check the hook's port: ${String(err)}`);
  }
}
