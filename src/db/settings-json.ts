/**
 * Settings that belong to the machine, not the browser: how this server
 * treats the sessions it creates. Kept in `~/.claude-mux/settings.json`
 * next to the sessions and projects, so every browser sees the same switch
 * and `claude-mux new-session` on the command line honours it too.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getSessionsDir } from "./sessions-json.js";

export interface Settings {
  /**
   * Run `/rc` in every session claude-mux itself creates, once its prompt is
   * up. Remote Control is what lets sessions on different machines see and
   * message each other (`ListAgents`, `SendMessage`) — but only for sessions
   * that have it on, which is easy to forget. Workers other tools spawn
   * straight into tmux are not claude-mux's to touch and are left alone.
   */
  autoRemoteControl: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoRemoteControl: false,
};

let settingsPath: string | null = null;

/** Overridable for tests; null means "next to the sessions directory". */
export function setSettingsPath(path: string | null): void {
  settingsPath = path;
}

function resolveSettingsPath(): string {
  return settingsPath ?? join(dirname(getSessionsDir()), "settings.json");
}

export function getSettings(): Settings {
  const path = resolveSettingsPath();
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Settings>;
    return {
      autoRemoteControl:
        typeof parsed.autoRemoteControl === "boolean"
          ? parsed.autoRemoteControl
          : DEFAULT_SETTINGS.autoRemoteControl,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Change some settings; returns the whole set as it now stands. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings() };
  if (typeof patch.autoRemoteControl === "boolean") next.autoRemoteControl = patch.autoRemoteControl;
  const path = resolveSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
  return next;
}

/**
 * Whether a tmux session name is one claude-mux gave: `<project>-<agent>-<ms>`.
 * Anything else — `quita-b1`, a hand-made `main` — was started by someone
 * else, a person or an orchestrator, and is not for claude-mux to configure.
 */
export function isClaudeMuxSessionName(name: string): boolean {
  return /-(?:claude|gemini|copilot)-\d{10,}$/.test(name);
}
