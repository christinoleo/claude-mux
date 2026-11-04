/**
 * A hook of ours that calls this machine's server, as an entry in Claude Code's
 * `settings.json`: how to recognise it, and the settings with it added or taken
 * out. Nothing here touches the disk. `setup` registers its own hooks by the
 * name of their script and passes these by.
 */

import type { ClaudeSettings, Hook } from "./hooks.js";

/** Where an `http` entry, or a `command` one that is a `curl`, sends its call. */
function urlOf(hook: Hook): string | null {
  if (hook.type === "http") return hook.url ?? null;
  return hook.command?.match(/http:\/\/127\.0\.0\.1\S*/)?.[0] ?? null;
}

/** The port an entry names when it calls `path` on this machine, or null when it is not ours. */
function portOf(hook: Hook, path: string): number | null {
  const named = urlOf(hook);
  if (!named) return null;
  try {
    const url = new URL(named);
    if (url.hostname !== "127.0.0.1" || url.pathname !== path) return null;
    // A URL drops the port its scheme implies.
    return Number(url.port || (url.protocol === "http:" ? 80 : 443));
  } catch {
    return null;
  }
}

/** The port our entry under `event` points at, or null when it is not installed. */
export function httpHookPort(settings: ClaudeSettings, event: string, path: string): number | null {
  const hooks = (settings.hooks?.[event] ?? []).flatMap((m) => m.hooks);
  return hooks.map((h) => portOf(h, path)).find((port) => port !== null) ?? null;
}

/** These settings without our entry, and with nothing else changed but what it alone left empty. */
export function withoutHttpHook(settings: ClaudeSettings, event: string, path: string): ClaudeSettings {
  const matchers = settings.hooks?.[event];
  if (!matchers) return settings;

  const kept = matchers
    .map((m) => ({ ...m, hooks: m.hooks.filter((h) => portOf(h, path) === null) }))
    .filter((m) => m.hooks.length > 0);

  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];

  const next: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** These settings with `hook` as our entry, in place of any older one. */
export function withLocalHook(settings: ClaudeSettings, event: string, path: string, hook: Hook): ClaudeSettings {
  const clean = withoutHttpHook(settings, event, path);
  return {
    ...clean,
    hooks: { ...clean.hooks, [event]: [...(clean.hooks?.[event] ?? []), { hooks: [hook] }] },
  };
}

/** These settings with our `http` entry for `port`, in place of any older one. */
export function withHttpHook(
  settings: ClaudeSettings,
  event: string,
  path: string,
  port: number,
  timeout: number
): ClaudeSettings {
  return withLocalHook(settings, event, path, { type: "http", url: `http://127.0.0.1:${port}${path}`, timeout });
}
