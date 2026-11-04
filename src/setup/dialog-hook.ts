/**
 * The hooks that let the dashboard answer a dialog, as entries in Claude Code's
 * `settings.json`. `PermissionRequest` is the one that holds. The others say the
 * dialog is over, since Claude Code never tells a held hook that a person
 * answered in the terminal. Nothing here touches the disk
 * (`src/server/dialog-switch.ts` does).
 */

import type { ClaudeSettings } from "./hooks.js";
import { httpHookPort, withHttpHook, withLocalHook, withoutHttpHook } from "./http-hook.js";

export const DIALOG_HOOK_PATH = "/api/hooks/dialog";
const DIALOG_ENDED_PATH = "/api/hooks/dialog/ended";

/**
 * The server lets go at ten minutes (`HOLD_LIMIT_MS`), and this is only the
 * backstop for a server that stopped answering without closing the connection.
 */
const HOLD_TIMEOUT_S = 605;

/**
 * These fire for every tool in every session. An `http` hook prints
 * `connect ECONNREFUSED` in the terminal on each one while the server is down,
 * so these are a `curl` that says nothing and gives up within a second. Without
 * `curl`, what ends a hold is the screen and the connection.
 */
const ENDED_EVENTS = ["PostToolUse", "PostToolUseFailure", "Stop"];

function endedHook(port: number) {
  const url = `http://127.0.0.1:${port}${DIALOG_ENDED_PATH}`;
  return {
    type: "command",
    command: `curl -s -m 1 -o /dev/null -H 'content-type: application/json' --data-binary @- ${url} || true`,
    timeout: 2,
  };
}

/** The port the hold points at, or null when the switch is off. */
export function dialogHookPort(settings: ClaudeSettings): number | null {
  return httpHookPort(settings, "PermissionRequest", DIALOG_HOOK_PATH);
}

export function withoutDialogHook(settings: ClaudeSettings): ClaudeSettings {
  return ENDED_EVENTS.reduce(
    (s, event) => withoutHttpHook(s, event, DIALOG_ENDED_PATH),
    withoutHttpHook(settings, "PermissionRequest", DIALOG_HOOK_PATH)
  );
}

export function withDialogHook(settings: ClaudeSettings, port: number): ClaudeSettings {
  return ENDED_EVENTS.reduce(
    (s, event) => withLocalHook(s, event, DIALOG_ENDED_PATH, endedHook(port)),
    withHttpHook(settings, "PermissionRequest", DIALOG_HOOK_PATH, port, HOLD_TIMEOUT_S)
  );
}
