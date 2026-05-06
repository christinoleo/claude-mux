#!/usr/bin/env node

/**
 * Claude Mux Hook Script
 *
 * This script is called by Claude Code hooks to update the session state
 * using JSON files (one per session).
 *
 * Usage: node claude-mux-hook.js <event>
 * Events: session-start, stop, permission-request, notification-idle,
 *         notification-permission, pre-tool-use, post-tool-use, session-end
 *
 * Hook input is received via stdin as JSON.
 */

import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// Paths
const LEGACY_CLAUDE_WATCH_DIR = join(homedir(), ".claude-watch");
const CLAUDE_MUX_DIR = join(homedir(), ".claude-mux");

// Inline migration: rename legacy ~/.claude-watch to ~/.claude-mux on first run
try {
  if (existsSync(LEGACY_CLAUDE_WATCH_DIR) && !existsSync(CLAUDE_MUX_DIR)) {
    renameSync(LEGACY_CLAUDE_WATCH_DIR, CLAUDE_MUX_DIR);
  }
} catch {
  // ignore — fall through with whichever dir we end up using
}

const SESSIONS_DIR = join(CLAUDE_MUX_DIR, "sessions");
const DEBUG_LOG_PATH = join(CLAUDE_MUX_DIR, "debug.log");

// Schema version
const SCHEMA_VERSION = 1;

function debugLog(message: string): void {
  const timestamp = new Date().toISOString();
  appendFileSync(DEBUG_LOG_PATH, `${timestamp} ${message}\n`);
}

interface Screenshot {
  path: string;
  timestamp: number;
}

interface Session {
  v: number;
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tmux_target: string | null;
  state: string;
  current_action: string | null;
  prompt_text: string | null;
  last_update: number;
  screenshots?: Screenshot[];
  chrome_active?: boolean;
  linked_to?: string | null;
  rc_url?: string | null;
  display_name?: string | null;
}

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
  // SessionStart payload: why the session is starting.
  // "compact"/"resume" share session_id with prior state; we must preserve user-meaningful fields.
  source?: "startup" | "resume" | "clear" | "compact";
  prompt?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    filePath?: string;
    description?: string;
  };
}

/**
 * Map Claude Code 2.1 PascalCase hook_event_name to our kebab-case event names.
 * Falls back to undefined for unknown/Notification events (handled by argv).
 */
function mapEventName(hookEventName?: string): string | undefined {
  if (!hookEventName) return undefined;

  const map: Record<string, string> = {
    SessionStart: "session-start",
    UserPromptSubmit: "user-prompt-submit",
    Stop: "stop",
    PermissionRequest: "permission-request",
    PreToolUse: "pre-tool-use",
    PostToolUse: "post-tool-use",
    PostToolUseFailure: "post-tool-use-failure",
    SessionEnd: "session-end",
    // Notification events can't be distinguished by hook_event_name alone
    // (all are "Notification"), so they fall through to argv
  };

  return map[hookEventName];
}

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function getSessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function readSession(id: string): Session | null {
  const path = getSessionPath(id);
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as Session;
  } catch {
    return null;
  }
}

function writeSession(session: Session): void {
  ensureSessionsDir();
  // Prune screenshots whose files no longer exist
  if (session.screenshots?.length) {
    session.screenshots = session.screenshots.filter(s => existsSync(s.path));
  }
  const path = getSessionPath(session.id);
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(session, null, 2));
  renameSync(tmpPath, path);
}

function deleteSessionFile(id: string): void {
  const path = getSessionPath(id);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Ignore
  }
}

/**
 * Delete all sessions with a given PID (except the one we're about to create).
 * Prevents duplicates when Claude restarts in the same terminal.
 */
function deleteSessionsByPid(pid: number, exceptId?: string): void {
  if (pid <= 0) return;
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const sessionId = file.replace(".json", "");
      if (exceptId && sessionId === exceptId) continue;
      const path = join(SESSIONS_DIR, file);
      try {
        const session = JSON.parse(readFileSync(path, "utf-8")) as Session;
        if (session.pid === pid) {
          unlinkSync(path);
        }
      } catch {
        // Skip corrupt files
      }
    }
  } catch {
    // Ignore
  }
}

// Delete any existing sessions with the same tmux_target (cleanup stale sessions)
// Returns linked_to from any deleted session so callers can preserve it.
function deleteSessionsByTmuxTarget(tmuxTarget: string, excludeId?: string): string | null {
  let linkedTo: string | null = null;
  try {
    if (!existsSync(SESSIONS_DIR)) return null;

    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const id = file.replace(".json", "");
      if (id === excludeId) continue;

      const session = readSession(id);
      if (session && session.tmux_target === tmuxTarget) {
        if (session.linked_to) linkedTo = session.linked_to;
        debugLog(`deleteSessionsByTmuxTarget: removing stale session ${id} with target ${tmuxTarget}`);
        deleteSessionFile(id);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
  return linkedTo;
}

function getTmuxTarget(): string | null {
  if (!process.env.TMUX) {
    return null;
  }

  try {
    const result = execSync(
      'tmux display-message -p "#{session_name}:#{window_index}.#{pane_index}"',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim();
  } catch {
    return null;
  }
}

function getGitRoot(cwd: string): string | null {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    return result.trim();
  } catch {
    return null;
  }
}

function getClaudePid(): number {
  try {
    let pid = process.ppid;
    debugLog(`getClaudePid: starting from ppid=${pid}`);

    for (let i = 0; i < 10; i++) {
      if (pid <= 1) break;

      const psOutput = execSync(`ps -p ${pid} -o ppid=,comm=,args=`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      debugLog(`getClaudePid: level ${i}, pid=${pid}, ps output: ${psOutput}`);

      const isClaudeCode =
        psOutput.includes("claude") && !psOutput.includes("claude-mux");

      if (isClaudeCode) {
        debugLog(`getClaudePid: found Claude at pid=${pid}`);
        return pid;
      }

      const ppid = parseInt(psOutput.split(/\s+/)[0], 10);
      if (isNaN(ppid) || ppid <= 1) break;

      pid = ppid;
    }
  } catch (e) {
    debugLog(`getClaudePid: error - ${e}`);
  }

  debugLog(`getClaudePid: returning 0 (not found)`);
  return 0;
}

function formatToolAction(
  toolName: string,
  toolInput?: HookInput["tool_input"]
): string {
  const name = toolName.replace(/^mcp__[^_]+__/, "");

  switch (toolName) {
    case "Bash":
      if (toolInput?.command) {
        const cmd = toolInput.command.slice(0, 30);
        return `Bash: ${cmd}${toolInput.command.length > 30 ? "..." : ""}`;
      }
      return "Running: Bash";

    case "Read":
    case "Edit":
    case "Write":
      if (toolInput?.file_path) {
        const file = toolInput.file_path.split("/").pop() || toolInput.file_path;
        return `${toolName}: ${file}`;
      }
      return `Running: ${toolName}`;

    case "Grep":
    case "Glob":
      return `Searching...`;

    case "Task":
      return "Running agent...";

    default:
      return `Running: ${name}`;
  }
}

async function readStdin(): Promise<HookInput> {
  return new Promise((resolve, reject) => {
    let data = "";

    const timeout = setTimeout(() => {
      reject(new Error("Timeout reading stdin"));
    }, 5000);

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Failed to parse hook input"));
      }
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function handleSessionStart(input: HookInput): void {
  const tmuxTarget = getTmuxTarget();
  const pid = getClaudePid();
  const existing = readSession(input.session_id);
  const source = input.source ?? "startup";
  // compact/resume keep the same session_id and continue prior work — preserve user-meaningful state.
  // clear wipes context but session identity remains, so keep display_name only.
  const preserveAll = source === "compact" || source === "resume";
  const preserveName = preserveAll || source === "clear";

  // Clean up any stale sessions with the same tmux_target before creating new one
  // Preserve linked_to from pre-registered sessions (set by new-session --linked-to)
  let linkedTo: string | null = null;
  if (tmuxTarget) {
    linkedTo = deleteSessionsByTmuxTarget(tmuxTarget, input.session_id);
  }

  // Remove any existing sessions with the same PID to prevent duplicates
  // (e.g. Claude restarting in the same terminal)
  deleteSessionsByPid(pid, input.session_id);

  const gitRoot = getGitRoot(input.cwd);

  const session: Session = {
    ...(preserveAll && existing ? existing : {}),
    v: SCHEMA_VERSION,
    id: input.session_id,
    pid,
    cwd: input.cwd,
    git_root: gitRoot,
    tmux_target: tmuxTarget,
    state: "idle",
    current_action: null,
    prompt_text: preserveAll ? (existing?.prompt_text ?? null) : null,
    display_name: preserveName ? (existing?.display_name ?? null) : null,
    last_update: Date.now(),
    linked_to: linkedTo ?? existing?.linked_to ?? null,
  };
  writeSession(session);
}

function getOrCreateSession(input: HookInput): Session {
  const existing = readSession(input.session_id);
  if (existing) return existing;

  // Session doesn't exist (e.g., resumed session) - create it
  const tmuxTarget = getTmuxTarget();
  let linkedTo: string | null = null;
  if (tmuxTarget) {
    linkedTo = deleteSessionsByTmuxTarget(tmuxTarget, input.session_id);
  }

  const gitRoot = getGitRoot(input.cwd);
  return {
    v: SCHEMA_VERSION,
    id: input.session_id,
    pid: getClaudePid(),
    cwd: input.cwd,
    git_root: gitRoot,
    tmux_target: tmuxTarget,
    state: "idle",
    current_action: null,
    prompt_text: null,
    last_update: Date.now(),
    linked_to: linkedTo,
  };
}

/** Truncate a prompt into a short title: first ~40 chars on a word boundary */
function promptToTitle(prompt: string): string | null {
  // Strip leading slashes, whitespace, markdown headers
  let text = prompt.replace(/^[#\s/]+/, '').trim();
  if (text.length < 4) return null; // too short to be useful (e.g. "1", "yes")
  // Take first line only
  text = text.split('\n')[0].trim();
  if (text.length <= 40) return text;
  // Cut at word boundary
  const truncated = text.slice(0, 40);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/** Set the tmux pane title via select-pane -T */
function setPaneTitle(target: string, title: string): void {
  try {
    execSync(`tmux select-pane -t ${JSON.stringify(target)} -T ${JSON.stringify(title)}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // ignore - not critical
  }
}

function handleUserPromptSubmit(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "busy";
  session.current_action = "Thinking...";
  // Capture the first user prompt as session name and set pane title
  if (input.prompt && !session.prompt_text) {
    session.prompt_text = input.prompt.slice(0, 120);
    const title = promptToTitle(input.prompt);
    if (title && session.tmux_target) {
      setPaneTitle(session.tmux_target, title);
    }
  }
  // Mirror Claude's `/rename <name>` slash command into display_name
  if (input.prompt) {
    const m = input.prompt.match(/^\s*\/rename\s+(.+?)\s*$/);
    if (m) {
      const next = m[1].trim().slice(0, 120);
      session.display_name = next.length > 0 ? next : null;
    } else if (/^\s*\/rename\s*$/.test(input.prompt)) {
      session.display_name = null;
    }
  }
  session.last_update = Date.now();
  writeSession(session);
}

function handleStop(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "idle";
  session.current_action = null;
  session.last_update = Date.now();
  writeSession(session);
}

function handlePermissionRequest(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "waiting";
  session.current_action = "Waiting...";
  session.last_update = Date.now();
  writeSession(session);
}

function handleNotificationIdle(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "idle";
  session.current_action = null;
  session.last_update = Date.now();
  writeSession(session);
}

function handleNotificationPermission(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "permission";
  session.current_action = "Waiting for permission";
  session.last_update = Date.now();
  writeSession(session);
}

function handleNotificationElicitation(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "waiting";
  session.current_action = "Waiting for input";
  session.last_update = Date.now();
  writeSession(session);
}

function handlePreToolUse(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.last_update = Date.now();
  session.state = "busy";
  session.current_action = input.tool_name
    ? formatToolAction(input.tool_name, input.tool_input)
    : "Working...";

  if (input.tool_name?.includes("take_screenshot") && input.tool_input?.filePath) {
    session.screenshots = session.screenshots || [];
    session.screenshots.push({
      path: input.tool_input.filePath,
      timestamp: Date.now(),
    });
  }

  writeSession(session);
}

function handlePostToolUse(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "busy";
  session.current_action = null;
  session.last_update = Date.now();
  writeSession(session);
}

function handlePostToolUseFailure(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "busy";
  session.current_action = null;
  session.last_update = Date.now();
  writeSession(session);
}

function handleSessionEnd(input: HookInput): void {
  deleteSessionFile(input.session_id);
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();

    // Claude Code 2.1+ passes event type in stdin JSON; fall back to argv for
    // backward compat and for Notification subtypes (all share hook_event_name="Notification")
    const event = mapEventName(input.hook_event_name) ?? process.argv[2];

    debugLog(`main: event=${event} (hook_event_name=${input.hook_event_name}, argv=${process.argv[2]})`);
    debugLog(`main: session_id=${input.session_id}, cwd=${input.cwd}`);

    if (!event) {
      debugLog(`main: no event resolved, exiting`);
      process.exit(1);
    }

    switch (event) {
      case "session-start":
        handleSessionStart(input);
        debugLog(`main: session-start completed`);
        break;
      case "user-prompt-submit":
        handleUserPromptSubmit(input);
        debugLog(`main: user-prompt-submit completed`);
        break;
      case "stop":
        handleStop(input);
        debugLog(`main: stop completed`);
        break;
      case "permission-request":
        handlePermissionRequest(input);
        debugLog(`main: permission-request completed`);
        break;
      case "notification-idle":
        handleNotificationIdle(input);
        debugLog(`main: notification-idle completed`);
        break;
      case "notification-permission":
        handleNotificationPermission(input);
        debugLog(`main: notification-permission completed`);
        break;
      case "notification-elicitation":
        handleNotificationElicitation(input);
        debugLog(`main: notification-elicitation completed`);
        break;
      case "pre-tool-use":
        handlePreToolUse(input);
        debugLog(`main: pre-tool-use completed`);
        break;
      case "post-tool-use":
        handlePostToolUse(input);
        debugLog(`main: post-tool-use completed`);
        break;
      case "post-tool-use-failure":
        handlePostToolUseFailure(input);
        debugLog(`main: post-tool-use-failure completed`);
        break;
      case "session-end":
        handleSessionEnd(input);
        debugLog(`main: session-end completed`);
        break;
      default:
        debugLog(`main: unknown event ${event}`);
        console.error(`Unknown event: ${event}`);
        process.exit(1);
    }
  } catch (error) {
    debugLog(`main: error - ${error}`);
    process.exit(0);
  }
}

main();
