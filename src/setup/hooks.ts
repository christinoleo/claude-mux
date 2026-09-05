import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { CLAUDE_SETTINGS_PATH, CLAUDE_DIR } from "../utils/paths.js";
import { VERSION } from "../utils/version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Hook {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: Hook[];
}

interface HooksConfig {
  [eventName: string]: HookMatcher[];
}

interface ClaudeMuxMetadata {
  version: string;
  installedAt: string;
  hookPath?: string;
}

interface ClaudeSettings {
  hooks?: HooksConfig;
  "claude-mux"?: ClaudeMuxMetadata;
  "claude-watch"?: ClaudeMuxMetadata;
  [key: string]: unknown;
}

export function getClaudeMuxMetadata(settings: ClaudeSettings): ClaudeMuxMetadata | undefined {
  return settings["claude-mux"] ?? settings["claude-watch"];
}

/** True when running from source (bun src/cli.ts) vs built dist/ */
const isDev = __dirname.includes("/src/");

export function getHookScriptPath(scriptName: string): string {
  if (isDev) {
    // Running from source — use .ts extension (bun can execute it directly)
    const tsName = scriptName.replace(/\.js$/, ".ts");
    return join(__dirname, "..", "hooks", tsName);
  }
  // Production — .js files live alongside us in dist/
  return join(__dirname, "..", "hooks", scriptName);
}

/**
 * The runtime that runs the hook script: whichever one is running setup, so
 * it is the same binary whose directory hookCommand puts on PATH. bun runs
 * the .ts source in dev and the built .js just as well as node does.
 */
export function getHookRunner(): string {
  return basename(process.execPath);
}

/**
 * The shell line Claude Code runs for one hook event.
 *
 * Hooks run through /bin/sh with the environment of the Claude process. A
 * session started by a script — a tmux window opened by a daemon, say — often
 * carries a PATH without the version manager that holds node, and the hook
 * then dies with "node: not found" before writing anything, so the pane shows
 * as a bare shell. The directory of the runtime installing the hooks is
 * appended so the runner resolves there too; appended rather than prepended,
 * so a PATH that already has a node keeps using its own.
 */
export function hookCommand(event: string): string {
  const runnerDir = dirname(process.execPath);
  return `PATH="$PATH:${runnerDir}" ${getHookRunner()} "${getHookScriptPath("claude-mux-hook.js")}" ${event}`;
}

export function getClaudeWatchHooks(): HooksConfig {
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("session-start"),
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("user-prompt-submit"),
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("stop"),
          },
        ],
      },
    ],
    PermissionRequest: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("permission-request"),
          },
        ],
      },
    ],
    Notification: [
      {
        matcher: "idle_prompt",
        hooks: [
          {
            type: "command",
            command: hookCommand("notification-idle"),
          },
        ],
      },
      {
        matcher: "permission_prompt",
        hooks: [
          {
            type: "command",
            command: hookCommand("notification-permission"),
          },
        ],
      },
      {
        matcher: "elicitation_dialog",
        hooks: [
          {
            type: "command",
            command: hookCommand("notification-elicitation"),
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("pre-tool-use"),
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("post-tool-use"),
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("post-tool-use-failure"),
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("session-end"),
          },
        ],
      },
    ],
  };
}

export function loadClaudeSettings(): ClaudeSettings {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    return JSON.parse(content) as ClaudeSettings;
  } catch {
    return {};
  }
}

/**
 * Get the version of installed claude-watch hooks.
 * Returns null if hooks are not installed or version is not tracked.
 */
export function getInstalledHooksVersion(): string | null {
  const settings = loadClaudeSettings();
  return getClaudeMuxMetadata(settings)?.version ?? null;
}

/**
 * Check if hooks need to be installed or updated.
 * Returns: 'install' | 'update' | 'current'
 */
export function checkHooksStatus(): "install" | "update" | "current" {
  const settings = loadClaudeSettings();

  // Check if hooks are installed at all
  if (!settings.hooks) {
    return "install";
  }

  // Check if any claude-watch hooks exist
  const hasClaudeWatchHooks = Object.values(settings.hooks).some((matchers) =>
    matchers.some((m) => m.hooks.some((h) => h.command.includes("claude-mux-hook")))
  );

  if (!hasClaudeWatchHooks) {
    return "install";
  }

  // Check version
  const meta = getClaudeMuxMetadata(settings);
  const installedVersion = meta?.version;
  if (!installedVersion || installedVersion !== VERSION) {
    return "update";
  }

  // Check if hook path has changed (e.g., switched from dev to prod or vice versa)
  const installedPath = meta?.hookPath;
  const currentPath = getHookScriptPath("claude-mux-hook.js");
  if (installedPath && installedPath !== currentPath) {
    return "update";
  }

  // Migrate legacy "claude-watch" key on the fly when "claude-mux" is missing
  if (!settings["claude-mux"] && settings["claude-watch"]) {
    return "update";
  }

  return "current";
}

export function mergeHooks(existing: HooksConfig | undefined, newHooks: HooksConfig): HooksConfig {
  const merged: HooksConfig = { ...existing };

  for (const [eventName, matchers] of Object.entries(newHooks)) {
    if (!merged[eventName]) {
      merged[eventName] = [];
    } else {
      // Remove any existing claude-watch hooks for this event (so we can replace them)
      merged[eventName] = merged[eventName].filter((existingMatcher) => {
        return !existingMatcher.hooks.some((h) => h.command.includes("claude-mux-hook"));
      });
    }

    // Add new claude-watch matchers
    for (const newMatcher of matchers) {
      merged[eventName].push(newMatcher);
    }
  }

  return merged;
}

export function removeClaudeWatchHooks(hooks: HooksConfig): HooksConfig {
  const cleaned: HooksConfig = {};

  for (const [eventName, matchers] of Object.entries(hooks)) {
    const filteredMatchers = matchers.filter((matcher) => {
      // Remove matchers that have claude-mux-hook commands
      return !matcher.hooks.some((h) => h.command.includes("claude-mux-hook"));
    });

    if (filteredMatchers.length > 0) {
      cleaned[eventName] = filteredMatchers;
    }
  }

  return cleaned;
}

export function generateDiff(
  oldSettings: ClaudeSettings,
  newSettings: ClaudeSettings
): string {
  const oldJson = JSON.stringify(oldSettings, null, 2);
  const newJson = JSON.stringify(newSettings, null, 2);

  if (oldJson === newJson) {
    return "No changes needed.";
  }

  // Simple diff display
  const lines: string[] = [];
  lines.push("Changes to ~/.claude/settings.json:");
  lines.push("");

  if (!oldSettings.hooks) {
    lines.push("+ Adding hooks configuration");
  } else {
    lines.push("~ Updating hooks configuration");
  }

  lines.push("");
  lines.push("New hooks to be added:");
  const hookEvents = Object.keys(getClaudeWatchHooks());
  for (const event of hookEvents) {
    lines.push(`  + ${event}: claude-mux-hook`);
  }

  return lines.join("\n");
}

export function saveClaudeSettings(settings: ClaudeSettings): void {
  // Ensure directory exists
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  const content = JSON.stringify(settings, null, 2);
  writeFileSync(CLAUDE_SETTINGS_PATH, content, "utf-8");
}

export function installHooks(): { diff: string; newSettings: ClaudeSettings } {
  const currentSettings = loadClaudeSettings();
  const claudeWatchHooks = getClaudeWatchHooks();
  const mergedHooks = mergeHooks(currentSettings.hooks, claudeWatchHooks);

  const newSettings: ClaudeSettings = {
    ...currentSettings,
    hooks: mergedHooks,
    "claude-mux": {
      version: VERSION,
      installedAt: new Date().toISOString(),
      hookPath: getHookScriptPath("claude-mux-hook.js"),
    },
  };

  delete newSettings["claude-watch"];

  const diff = generateDiff(currentSettings, newSettings);

  return { diff, newSettings };
}

export function uninstallHooks(): void {
  const currentSettings = loadClaudeSettings();

  if (!currentSettings.hooks) {
    return;
  }

  const cleanedHooks = removeClaudeWatchHooks(currentSettings.hooks);

  const newSettings: ClaudeSettings = {
    ...currentSettings,
  };

  if (Object.keys(cleanedHooks).length === 0) {
    delete newSettings.hooks;
  } else {
    newSettings.hooks = cleanedHooks;
  }

  // Remove claude-mux metadata (and legacy claude-watch key)
  delete newSettings["claude-mux"];
  delete newSettings["claude-watch"];

  saveClaudeSettings(newSettings);
}
