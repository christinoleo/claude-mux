#!/usr/bin/env node

/**
 * Claude Mux Hook Script
 *
 * This script is called by Claude Code hooks to update the session state
 * using JSON files (one per session).
 *
 * Usage: node claude-mux-hook.js <event>
 * Events: session-start, stop, permission-request, notification-idle,
 *         notification-permission, pre-tool-use, post-tool-use, session-end,
 *         subagent-start, subagent-stop
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
  statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseMcpToolName } from "../transcript/mcp.js";
import { readSubagentMeta, subagentDir, type SubagentMeta } from "../transcript/tailer.js";
import type { Subagent } from "../db/sessions-json.js";
import { ASKING, AWAITING_INPUT } from "../session-state.js";

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

/** An Agent tool call seen in PreToolUse, waiting for the SubagentStart it causes. */
interface AgentCall {
  type: string;
  description: string | null;
  tool_use_id: string | null;
}

interface Session {
  v: number;
  id: string;
  pid: number;
  cwd: string;
  transcript_path?: string | null;
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
  /** In-flight background work (agents, shells, workflows) at the last Stop. */
  background_tasks?: number;
  /** When the user's latest prompt started a turn (epoch ms). */
  turn_started_at?: number | null;
  /** When the latest turn ended for good, background work included (epoch ms). */
  turn_completed_at?: number | null;
  /** Set when the maestro daemon started this session: its role and issue. */
  maestro_role?: string | null;
  maestro_issue?: number | null;
  subagents?: Subagent[];
  /** Agent calls not yet matched to a SubagentStart; see takeAgentCall. */
  agent_calls?: AgentCall[];
}

/** One entry of the Stop payload's `background_tasks`. */
interface BackgroundTask {
  type?: string;
  agent_type?: string;
}

interface HookInput {
  session_id: string;
  cwd: string;
  /** JSONL Claude Code writes for this session; sent on every hook event. */
  transcript_path?: string;
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
    subagent_type?: string;
  };
  tool_use_id?: string;
  /**
   * Stop payload: work still in flight when the turn ended. A turn that ends
   * with a background agent or shell running is paused, not finished — the
   * task's completion wakes the session again without any prompt from the user.
   * Claude Code lists only running work here.
   */
  background_tasks?: BackgroundTask[];
  /**
   * Set on tool events fired from inside a subagent, with the parent's session
   * id, and on SubagentStart/SubagentStop, which name the agent they are about.
   */
  agent_id?: string;
  agent_type?: string;
  /** SubagentStop only: the agent's own JSONL. */
  agent_transcript_path?: string;
}

/**
 * Task types whose completion wakes the turn. A background shell may be a dev
 * server that never ends, and a monitor watches indefinitely; a turn that ends
 * with only those running is over, and the session must read as idle or its
 * queue never drains.
 */
const WAKING_TASKS = new Set(["subagent", "workflow"]);

function wakingTasks(input: HookInput): BackgroundTask[] {
  return (input.background_tasks ?? []).filter((t) => t.type !== undefined && WAKING_TASKS.has(t.type));
}

/** The last Stop left work running; the ready prompt is a pause, not the end. */
function pausedOnBackground(session: Session): boolean {
  return (session.background_tasks ?? 0) > 0;
}

/** "Waiting on agent: Explore", "Waiting on 3 background tasks". */
function describeBackground(tasks: BackgroundTask[]): string {
  if (tasks.length > 1) return `Waiting on ${tasks.length} agents`;
  const [t] = tasks;
  return t.type === "subagent" ? `Waiting on agent: ${t.agent_type}` : `Waiting on ${t.type}`;
}

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
    SubagentStart: "subagent-start",
    SubagentStop: "subagent-stop",
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

/** How long a finished subagent stays listed before it is pruned from the JSON. */
const FINISHED_SUBAGENT_TTL_MS = 10 * 60 * 1000;

function writeSession(session: Session): void {
  ensureSessionsDir();
  // Prune screenshots whose files no longer exist
  if (session.screenshots?.length) {
    session.screenshots = session.screenshots.filter(s => existsSync(s.path));
  }
  if (session.subagents?.length) {
    const cutoff = Date.now() - FINISHED_SUBAGENT_TTL_MS;
    session.subagents = session.subagents.filter(a => a.ended_at === null || a.ended_at > cutoff);
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

/**
 * The pane this hook runs in, as `session:window.pane`.
 *
 * Asked for its own pane, and not left to tmux's idea of the current one:
 * without `-t`, a command run from a window that is not the active one is
 * answered for the active window. Ten Claude Codes in one tmux session, each
 * in its own window, then all claim window 0, every SessionStart deletes the
 * others as stale duplicates, and the one file left is rewritten by whichever
 * of them spoke last.
 */
function getTmuxTarget(): string | null {
  if (!process.env.TMUX) {
    return null;
  }

  try {
    const pane = process.env.TMUX_PANE;
    const target = pane ? ` -t ${JSON.stringify(pane)}` : "";
    const result = execSync(
      `tmux display-message -p${target} "#{session_name}:#{window_index}.#{pane_index}"`,
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
  const name = parseMcpToolName(toolName)?.tool ?? toolName;

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
    case "Agent":
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
  // What a SessionStart keeps, widest source first — each rung includes the one
  // below it. compact fires mid-turn and the agent carries straight on, so even
  // the running state survives; without that the session reads as free and the
  // message queue drains into a busy pane. resume continues prior work but lands
  // at a prompt. clear wipes the context while the pane stays the same named
  // session. startup keeps nothing.
  const keepRunState = source === "compact";
  const keepContext = keepRunState || source === "resume";
  const keepName = keepContext || source === "clear";

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
    ...(keepContext && existing ? existing : {}),
    v: SCHEMA_VERSION,
    id: input.session_id,
    pid,
    cwd: input.cwd,
    transcript_path: input.transcript_path ?? existing?.transcript_path ?? null,
    git_root: gitRoot,
    tmux_target: tmuxTarget,
    state: keepRunState ? (existing?.state ?? "idle") : "idle",
    current_action: keepRunState ? (existing?.current_action ?? null) : null,
    prompt_text: keepContext ? (existing?.prompt_text ?? null) : null,
    display_name: keepName ? (existing?.display_name ?? null) : null,
    last_update: Date.now(),
    linked_to: linkedTo ?? existing?.linked_to ?? null,
    ...maestroFields(),
  };
  writeSession(session);
}

/**
 * The maestro daemon starts each worker with MAESTRO_ROLE and MAESTRO_ISSUE in
 * its environment, and the hook inherits Claude Code's environment, so the
 * session can say which issue it is working without anyone asking GitHub.
 */
function maestroFields(): Pick<Session, "maestro_role" | "maestro_issue"> {
  const role = process.env.MAESTRO_ROLE || null;
  const issue = Number.parseInt(process.env.MAESTRO_ISSUE ?? "", 10);
  return { maestro_role: role, maestro_issue: role && Number.isFinite(issue) ? issue : null };
}

function getOrCreateSession(input: HookInput): Session {
  const existing = readSession(input.session_id);
  if (existing) {
    // Sessions written before this field existed, and resumed sessions whose
    // file moved, pick it up on their next event.
    if (input.transcript_path) existing.transcript_path = input.transcript_path;
    if (existing.maestro_role === undefined) Object.assign(existing, maestroFields());
    return existing;
  }

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
    transcript_path: input.transcript_path ?? null,
    git_root: gitRoot,
    tmux_target: tmuxTarget,
    state: "idle",
    current_action: null,
    prompt_text: null,
    last_update: Date.now(),
    linked_to: linkedTo,
    ...maestroFields(),
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
  session.background_tasks = 0;
  session.turn_started_at = Date.now();
  // A new turn retires the last one's ending; one cut short by Escape never
  // gets a Stop, and must not come back as the old turn's unread "Done".
  session.turn_completed_at = null;
  // Capture the first user prompt as session name and set pane title.
  // Slash commands are control input, not a description of the work — and one of
  // them (`/rename`) is injected by the dashboard, which would otherwise title the
  // session after its own rename call.
  if (input.prompt && !session.prompt_text && !/^\s*\//.test(input.prompt)) {
    session.prompt_text = input.prompt.slice(0, 120);
    const title = promptToTitle(input.prompt);
    if (title && session.tmux_target) {
      setPaneTitle(session.tmux_target, title);
    }
  }
  // Mirror Claude's `/rename <name>` slash command into display_name. Kept in
  // step with sanitizeDisplayName in src/db/sessions-json.ts, which does the same
  // normalising for names arriving from the dashboard — this file stays free of
  // repo imports so it starts fast on every hook event.
  const renamed = input.prompt?.match(/^\s*\/rename(?:\s+(.*))?$/);
  if (renamed) {
    const next = (renamed[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    session.display_name = next || null;
  }
  session.last_update = Date.now();
  writeSession(session);
}

function handleStop(input: HookInput): void {
  const session = getOrCreateSession(input);
  const pending = wakingTasks(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.background_tasks = pending.length;
  if (pending.length > 0) {
    // Paused, not done: a background agent or shell will wake the turn again.
    session.state = "busy";
    session.current_action = describeBackground(pending);
  } else {
    session.state = "idle";
    session.current_action = null;
    // Nothing will wake the turn, so no agent is still running: one cut short
    // by Escape never sends its SubagentStop, and a parked call that never
    // started (denied, say) must not lend its description to a later agent.
    const now = Date.now();
    for (const agent of session.subagents ?? []) {
      if (agent.state === "running") {
        agent.state = "done";
        agent.ended_at = now;
      }
    }
    session.agent_calls = [];
    // The dashboard's unread "Done" compares this against when someone last
    // looked at the session; a pause on background work is not an ending.
    session.turn_completed_at = Date.now();
  }
  session.last_update = Date.now();
  writeSession(session);
}

function handlePermissionRequest(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "waiting";
  // AskUserQuestion goes through the permission machinery too; keep saying
  // it is a question, which is what the notification below reads.
  session.current_action = input.tool_name === "AskUserQuestion" ? ASKING : "Waiting...";
  session.last_update = Date.now();
  writeSession(session);
}

function handleNotificationIdle(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  // The prompt sits idle while a background agent works, and this fires a
  // minute in. The last Stop knew whether work was still in flight; trust it.
  if (!pausedOnBackground(session)) {
    session.state = "idle";
    session.current_action = null;
  }
  session.last_update = Date.now();
  writeSession(session);
}

function handleNotificationPermission(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  // Claude Code sends its permission notification for a question as well,
  // seconds after the dialog is drawn. The question is not asking for
  // permission, and reading it as one sends the dashboard to the terminal
  // for an answer it could offer itself; the wait also started back when
  // the question did.
  if (session.state === "waiting" && session.current_action === ASKING) {
    writeSession(session);
    return;
  }
  session.state = "permission";
  session.current_action = "Waiting for permission";
  session.last_update = Date.now();
  writeSession(session);
}

function handleNotificationElicitation(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "waiting";
  session.current_action = AWAITING_INPUT;
  session.last_update = Date.now();
  writeSession(session);
}

function handlePreToolUse(input: HookInput): void {
  const session = getOrCreateSession(input);

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.last_update = Date.now();
  if (input.agent_id) {
    // A subagent's tool calls arrive under the parent's session id. The parent
    // is busy, but what it is doing is waiting on the agent, not reading foo.ts.
    session.state = "busy";
  } else if (input.tool_name === "AskUserQuestion") {
    // The tool's whole job is to wait for the user, so the session is waiting
    // from the moment it is called. The permission notification says the
    // same thing a beat later; reporting it here means the dashboard shows
    // the dialog's rows as soon as they are drawn, not after that beat.
    session.state = "waiting";
    session.current_action = ASKING;
  } else {
    session.state = "busy";
    session.current_action = input.tool_name
      ? formatToolAction(input.tool_name, input.tool_input)
      : "Working...";
  }

  if (isAgentTool(input.tool_name) && !input.agent_id) {
    session.agent_calls = [
      ...(session.agent_calls ?? []).slice(-(MAX_AGENT_CALLS - 1)),
      {
        type: input.tool_input?.subagent_type ?? "general-purpose",
        description: input.tool_input?.description ?? null,
        tool_use_id: input.tool_use_id ?? null,
      },
    ];
  }

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
  // Same as PreToolUse: a subagent's tool events leave the parent's label alone.
  if (!input.agent_id) session.current_action = null;
  session.last_update = Date.now();
  writeSession(session);
}

function handlePostToolUseFailure(input: HookInput): void {
  const session = getOrCreateSession(input);

  // An agent that dies with an error still gets its SubagentStop, either side
  // of this; the failure is what tells the two endings apart.
  if (isAgentTool(input.tool_name) && input.tool_use_id) {
    const agent = session.subagents?.find(a => a.tool_use_id === input.tool_use_id);
    if (agent) {
      agent.state = "failed";
      agent.ended_at ??= Date.now();
    }
  }

  session.tmux_target = getTmuxTarget() ?? session.tmux_target;
  session.state = "busy";
  session.current_action = null;
  session.last_update = Date.now();
  writeSession(session);
}

/** The tool that spawns a subagent: `Agent`, called `Task` before Claude Code 2.1. */
function isAgentTool(name?: string): boolean {
  return name === "Agent" || name === "Task";
}

/** Agent calls kept waiting for their SubagentStart; enough for a wide fan-out. */
const MAX_AGENT_CALLS = 20;

/**
 * Where Claude Code keeps a subagent's transcript: beside the parent's JSONL.
 * SubagentStart does not say, SubagentStop does.
 */
function subagentTranscriptPath(input: HookInput, agentId: string): string | null {
  if (!input.transcript_path) return null;
  return join(subagentDir(input.transcript_path), `agent-${agentId}.jsonl`);
}

/**
 * The PreToolUse that spawned this agent, taken off the list: the oldest call
 * for the same agent type, which is the order Claude Code starts them in.
 */
function takeAgentCall(session: Session, type: string, toolUseId?: string): AgentCall | null {
  const calls = session.agent_calls ?? [];
  const i = toolUseId
    ? calls.findIndex(c => c.tool_use_id === toolUseId)
    : calls.findIndex(c => c.type === type);
  if (i < 0) return null;
  const [call] = calls.splice(i, 1);
  session.agent_calls = calls;
  return call;
}

/**
 * The description and spawning call from the agent's `.meta.json`, kept only
 * when they are strings: the broadcast schema is strict, and one bad value
 * would stop the whole sessions message from parsing.
 */
function agentMeta(transcriptPath: string | null): { description?: string; toolUseId?: string } {
  const meta: SubagentMeta = transcriptPath ? readSubagentMeta(transcriptPath) : {};
  return {
    ...(typeof meta.description === "string" ? { description: meta.description } : {}),
    ...(typeof meta.toolUseId === "string" ? { toolUseId: meta.toolUseId } : {}),
  };
}

/** When the agent's transcript appeared, for an agent first heard of at its stop. */
function fileBirth(path: string | null): number {
  try {
    return path ? statSync(path).birthtimeMs || Date.now() : Date.now();
  } catch {
    return Date.now();
  }
}

function newSubagent(
  id: string,
  type: string,
  transcriptPath: string | null,
  meta: { description?: string; toolUseId?: string },
  call?: AgentCall | null
): Subagent {
  return {
    id,
    type,
    description: meta.description ?? call?.description ?? null,
    state: "running",
    started_at: Date.now(),
    ended_at: null,
    transcript_path: transcriptPath,
    tool_use_id: meta.toolUseId ?? call?.tool_use_id ?? null,
  };
}

function handleSubagentStart(input: HookInput): void {
  if (!input.agent_id) return;
  const session = getOrCreateSession(input);

  const type = input.agent_type || "general-purpose";
  const transcriptPath = subagentTranscriptPath(input, input.agent_id);
  const meta = agentMeta(transcriptPath);
  const agent = newSubagent(input.agent_id, type, transcriptPath, meta, takeAgentCall(session, type, meta.toolUseId));
  session.subagents = [...(session.subagents ?? []).filter(a => a.id !== agent.id), agent];
  session.last_update = Date.now();
  writeSession(session);
}

function handleSubagentStop(input: HookInput): void {
  if (!input.agent_id) return;
  const session = getOrCreateSession(input);

  let agent = session.subagents?.find(a => a.id === input.agent_id);
  const transcriptPath =
    input.agent_transcript_path ?? subagentTranscriptPath(input, input.agent_id) ?? agent?.transcript_path ?? null;
  // Read again even when the start found a description: that one may have come
  // from pairing the start with a parked call by type, and the meta is exact.
  const meta = agentMeta(transcriptPath);
  if (!agent) {
    // Started before the hook knew about subagents, or its start was pruned.
    agent = newSubagent(input.agent_id, input.agent_type || "general-purpose", transcriptPath, meta);
    agent.started_at = fileBirth(transcriptPath);
    session.subagents = [...(session.subagents ?? []), agent];
  }
  if (agent.state === "running") agent.state = "done";
  agent.ended_at ??= Date.now();
  agent.transcript_path = transcriptPath;
  agent.description = meta.description ?? agent.description;
  agent.tool_use_id = meta.toolUseId ?? agent.tool_use_id;
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
    debugLog(`main: session_id=${input.session_id}, cwd=${input.cwd}${input.source ? `, source=${input.source}` : ""}`);

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
      case "subagent-start":
        handleSubagentStart(input);
        debugLog(`main: subagent-start completed`);
        break;
      case "subagent-stop":
        handleSubagentStop(input);
        debugLog(`main: subagent-stop completed`);
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
