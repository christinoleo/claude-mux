/**
 * The `MessageDisplay` hook as an entry in Claude Code's `settings.json`.
 * Nothing here touches the disk (`src/server/live-text-switch.ts` does).
 */

import type { ClaudeSettings } from "./hooks.js";
import { httpHookPort, withHttpHook, withoutHttpHook } from "./http-hook.js";

const LIVE_TEXT_EVENT = "MessageDisplay";
const LIVE_TEXT_PATH = "/api/hooks/message-display";

/** The port the hook in these settings points at, or null when it is not installed. */
export function liveTextHookPort(settings: ClaudeSettings): number | null {
  return httpHookPort(settings, LIVE_TEXT_EVENT, LIVE_TEXT_PATH);
}

export function withoutLiveTextHook(settings: ClaudeSettings): ClaudeSettings {
  return withoutHttpHook(settings, LIVE_TEXT_EVENT, LIVE_TEXT_PATH);
}

/** The call holds the session's screen until it is answered, so the timeout is the shortest there is. */
export function withLiveTextHook(settings: ClaudeSettings, port: number): ClaudeSettings {
  return withHttpHook(settings, LIVE_TEXT_EVENT, LIVE_TEXT_PATH, port, 1);
}
