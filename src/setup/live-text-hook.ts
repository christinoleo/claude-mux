/**
 * The `MessageDisplay` hook as an entry in Claude Code's `settings.json`: what
 * it looks like, how to recognise ours, and the settings with it added or
 * taken out. Nothing here touches the disk (`src/server/live-text-switch.ts`
 * does). `setup` registers its hooks by command and passes this one by.
 */

import type { ClaudeSettings, Hook } from "./hooks.js";

const LIVE_TEXT_EVENT = "MessageDisplay";
const LIVE_TEXT_PATH = "/api/hooks/message-display";

/** The port an entry names, or null when it is not ours. */
function portOf(hook: Hook): number | null {
  if (hook.type !== "http" || !hook.url) return null;
  try {
    const url = new URL(hook.url);
    if (url.hostname !== "127.0.0.1" || url.pathname !== LIVE_TEXT_PATH) return null;
    // A URL drops the port its scheme implies.
    return Number(url.port || (url.protocol === "http:" ? 80 : 443));
  } catch {
    return null;
  }
}

/** The port the hook in these settings points at, or null when it is not installed. */
export function liveTextHookPort(settings: ClaudeSettings): number | null {
  const hooks = (settings.hooks?.[LIVE_TEXT_EVENT] ?? []).flatMap((m) => m.hooks);
  return hooks.map(portOf).find((port) => port !== null) ?? null;
}

/** These settings without our entry, and with nothing else changed but what it alone left empty. */
export function withoutLiveTextHook(settings: ClaudeSettings): ClaudeSettings {
  const matchers = settings.hooks?.[LIVE_TEXT_EVENT];
  if (!matchers) return settings;

  const kept = matchers
    .map((m) => ({ ...m, hooks: m.hooks.filter((h) => portOf(h) === null) }))
    .filter((m) => m.hooks.length > 0);

  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks[LIVE_TEXT_EVENT] = kept;
  else delete hooks[LIVE_TEXT_EVENT];

  const next: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/**
 * These settings with our entry for `port`, in place of any older one. The call
 * holds the session's screen until it is answered, so the timeout is the
 * shortest there is.
 */
export function withLiveTextHook(settings: ClaudeSettings, port: number): ClaudeSettings {
  const clean = withoutLiveTextHook(settings);
  const hook: Hook = { type: "http", url: `http://127.0.0.1:${port}${LIVE_TEXT_PATH}`, timeout: 1 };
  return {
    ...clean,
    hooks: {
      ...clean.hooks,
      [LIVE_TEXT_EVENT]: [...(clean.hooks?.[LIVE_TEXT_EVENT] ?? []), { hooks: [hook] }],
    },
  };
}
