/**
 * A switch per machine that is an `http` hook in `~/.claude/settings.json`: the
 * entry being there is what "on" means, so there is no second copy of the state
 * to disagree with what sessions actually read, and `setup` keeps the switch
 * just by leaving the entry alone.
 *
 * Only the production server writes. A dev server shares this file with every
 * real session on the machine and with a port that would be gone by morning,
 * so it can read a switch and nothing more (`HookWriter.dev`).
 */

import { readClaudeSettings, saveClaudeSettings, type ClaudeSettings } from "../setup/hooks.js";

export interface HookWriter {
  dev: boolean;
  port: number;
}

/** What a switch knows about its entries, none of it touching the disk. */
interface SwitchHook {
  name: string;
  port: (settings: ClaudeSettings) => number | null;
  add: (settings: ClaudeSettings, port: number) => ClaudeSettings;
  remove: (settings: ClaudeSettings) => ClaudeSettings;
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

export function hookSwitch({ name, port: portIn, add, remove }: SwitchHook) {
  return {
    read({ dev }: Pick<HookWriter, "dev">): { enabled: boolean; switchable: boolean } {
      let enabled = false;
      try {
        enabled = portIn(readClaudeSettings()) !== null;
      } catch {
        // Unreadable settings hold no hook a session could run either.
      }
      return { enabled, switchable: !dev };
    },

    /** Turn the switch. False when this server may not; throws when the settings cannot be read or written. */
    set(enabled: boolean, { dev, port }: HookWriter): boolean {
      if (dev) return false;
      const current = readClaudeSettings();
      // Every session on the machine rereads the file, so a switch already there writes nothing.
      if (portIn(current) === (enabled ? port : null)) return true;
      saveClaudeSettings(enabled ? add(current, port) : remove(current));
      return true;
    },

    /**
     * At startup: a switch left on keeps pointing at this server when it comes up
     * on another port. Not while a server still answers on the old one, because a
     * second built server beside the real one (trying out a build) must not take
     * every session's hook with it and leave a dead port when it exits. A machine
     * with the switch off is left as it is. Never rejects, since nothing about
     * this is worth a server that will not start.
     */
    async follow({ dev, port }: HookWriter, answers: (port: number) => Promise<boolean> = serverAnswers): Promise<void> {
      if (dev) return;
      try {
        const installed = portIn(readClaudeSettings());
        if (installed === null || installed === port || (await answers(installed))) return;
        saveClaudeSettings(add(readClaudeSettings(), port));
      } catch (err) {
        console.warn(`[${name}] could not check the hook's port: ${String(err)}`);
      }
    },
  };
}
