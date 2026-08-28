import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  rmSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { isPidAlive } from "../utils/pid.js";

// Paths
const LEGACY_CLAUDE_WATCH_DIR = join(homedir(), ".claude-watch");
const CLAUDE_MUX_DIR = join(homedir(), ".claude-mux");

try {
  if (existsSync(LEGACY_CLAUDE_WATCH_DIR) && !existsSync(CLAUDE_MUX_DIR)) {
    renameSync(LEGACY_CLAUDE_WATCH_DIR, CLAUDE_MUX_DIR);
  }
} catch {
  // ignore — caller will create the new dir if needed
}

const DEFAULT_SESSIONS_DIR = join(CLAUDE_MUX_DIR, "sessions");
const LINKS_PATH = join(CLAUDE_MUX_DIR, "links.json");

// Attachments root: per-session uploads (see docs/adr/0001, docs/adr/0002).
export const ATTACHMENTS_DIR = join(CLAUDE_MUX_DIR, "attachments");

export function getSessionAttachmentsDir(id: string): string {
  return resolve(ATTACHMENTS_DIR, id);
}

// Schema version
const SCHEMA_VERSION = 1;

// Allow overriding sessions directory for testing
let sessionsDir = DEFAULT_SESSIONS_DIR;

/**
 * Set sessions directory (for testing).
 */
export function setSessionsDir(dir: string | null): void {
  sessionsDir = dir ?? DEFAULT_SESSIONS_DIR;
}

export type SessionState = "busy" | "idle" | "waiting" | "permission";
export type SessionAgent = "claude" | "gemini" | "copilot";

export interface Screenshot {
  path: string;
  timestamp: number;
}

export interface Session {
  v: number;
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tmux_target: string | null;
  state: SessionState;
  current_action: string | null;
  prompt_text: string | null;
  last_update: number;
  screenshots?: Screenshot[];
  chrome_active?: boolean;
  linked_to?: string | null;
  rc_url?: string | null;
  display_name?: string | null;
  agent?: SessionAgent;
}

export interface SessionInput {
  id: string;
  pid: number;
  cwd: string;
  git_root?: string | null;
  tmux_target?: string | null;
  state?: SessionState;
  current_action?: string | null;
  prompt_text?: string | null;
  linked_to?: string | null;
  rc_url?: string | null;
  agent?: SessionAgent;
}

export interface SessionUpdate {
  state?: SessionState;
  current_action?: string | null;
  prompt_text?: string | null;
  rc_url?: string | null;
  display_name?: string | null;
}

/**
 * Ensure sessions directory exists.
 */
function ensureSessionsDir(): void {
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }
}

/**
 * Get the file path for a session.
 */
function getSessionPath(id: string): string {
  return join(sessionsDir, `${id}.json`);
}

/**
 * Atomically write a session file (temp + rename).
 */
function writeSessionFile(session: Session): void {
  ensureSessionsDir();
  const path = getSessionPath(session.id);
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(session, null, 2));
  renameSync(tmpPath, path);
}

/**
 * Read a session from its JSON file.
 */
export function getSession(id: string): Session | null {
  const path = getSessionPath(id);
  try {
    if (!existsSync(path)) return null;
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data) as Session;
  } catch {
    return null;
  }
}

/**
 * Create or update a session.
 */
export function upsertSession(input: SessionInput): Session {
  const existing = getSession(input.id);

  const session: Session = {
    v: SCHEMA_VERSION,
    id: input.id,
    pid: input.pid,
    cwd: input.cwd,
    git_root: input.git_root ?? existing?.git_root ?? null,
    tmux_target: input.tmux_target ?? existing?.tmux_target ?? null,
    state: input.state ?? existing?.state ?? "busy",
    current_action: input.current_action ?? existing?.current_action ?? null,
    prompt_text: input.prompt_text ?? existing?.prompt_text ?? null,
    last_update: Date.now(),
    linked_to: input.linked_to ?? existing?.linked_to ?? null,
    rc_url: input.rc_url ?? existing?.rc_url ?? null,
    display_name: existing?.display_name ?? null,
    agent: input.agent ?? existing?.agent ?? "claude",
  };

  writeSessionFile(session);
  return session;
}

/**
 * Names travel two ways: into the session JSON, and into the pane as a
 * `/rename <name>` line. Newlines and control characters would submit extra
 * lines to the agent, so they are collapsed before the name is stored.
 */
export function sanitizeDisplayName(name: string | null | undefined): string | null {
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 120) : null;
}

/**
 * Update specific fields of a session.
 */
export function updateSession(id: string, update: SessionUpdate): void {
  const session = getSession(id);
  if (!session) return;

  if (update.state !== undefined) {
    session.state = update.state;
  }
  if (update.current_action !== undefined) {
    session.current_action = update.current_action;
  }
  if (update.prompt_text !== undefined) {
    session.prompt_text = update.prompt_text;
  }
  if (update.rc_url !== undefined) {
    session.rc_url = update.rc_url;
  }
  if (update.display_name !== undefined) {
    session.display_name = sanitizeDisplayName(update.display_name);
  }
  session.last_update = Date.now();

  writeSessionFile(session);
}

/**
 * Delete a session file.
 */
export function deleteSession(id: string): void {
  const path = getSessionPath(id);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Ignore errors (file may already be deleted)
  }
  // Sweep this session's attachment dir. Single cleanup site for attachment
  // backing files (see docs/adr/0002).
  try {
    const attachDir = getSessionAttachmentsDir(id);
    if (existsSync(attachDir)) {
      rmSync(attachDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort
  }
}

/**
 * Clear chrome_active flag for a session.
 */
export function clearChromeActive(id: string): boolean {
  const session = getSession(id);
  if (!session) return false;

  session.chrome_active = false;
  session.last_update = Date.now();
  writeSessionFile(session);
  return true;
}

/**
 * Remove a screenshot from a session.
 */
export function removeScreenshot(id: string, screenshotPath: string): boolean {
  const session = getSession(id);
  if (!session || !session.screenshots) return false;

  const initialLength = session.screenshots.length;
  session.screenshots = session.screenshots.filter((s) => s.path !== screenshotPath);

  if (session.screenshots.length === initialLength) {
    return false; // Screenshot not found
  }

  session.last_update = Date.now();
  writeSessionFile(session);
  return true;
}

/**
 * Get all sessions, sorted by ID for stable ordering.
 */
export function getAllSessions(): Session[] {
  ensureSessionsDir();

  const sessions: Session[] = [];

  try {
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const data = readFileSync(join(sessionsDir, file), "utf-8");
        sessions.push(JSON.parse(data) as Session);
      } catch {
        // Skip corrupt or deleted files
        continue;
      }
    }
  } catch {
    return [];
  }

  // Sort by ID for stable ordering (sessions don't jump around)
  sessions.sort((a, b) => a.id.localeCompare(b.id));

  return sessions;
}

/**
 * Get all session PIDs.
 */
export function getSessionPids(): number[] {
  return getAllSessions().map((s) => s.pid);
}

/**
 * Delete sessions by PIDs.
 */
export function deleteSessionsByPids(pids: number[]): void {
  if (pids.length === 0) return;

  const pidSet = new Set(pids);
  const sessions = getAllSessions();

  for (const session of sessions) {
    if (pidSet.has(session.pid)) {
      deleteSession(session.id);
    }
  }
}

/**
 * Clean up stale sessions (PIDs that no longer exist).
 */
export function cleanupStaleSessions(): number {
  ensureSessionsDir();

  let removed = 0;

  try {
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const path = join(sessionsDir, file);
      try {
        const data = readFileSync(path, "utf-8");
        const session = JSON.parse(data) as Session;

        // Skip PID 0 (unknown) - only session-end can clean those
        if (session.pid > 0 && !isPidAlive(session.pid)) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // Corrupted file - remove it
        try {
          unlinkSync(path);
          removed++;
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return removed;
}

/**
 * Get sessions directory path (for testing).
 */
export function getSessionsDir(): string {
  return sessionsDir;
}

// ============================================================================
// Session Links (separate file, not touched by hooks)
// ============================================================================

/**
 * Read all session links. Returns a map of orchestratorTmuxTarget → mainTmuxTarget.
 */
export function readLinks(): Record<string, string> {
  try {
    if (!existsSync(LINKS_PATH)) return {};
    return JSON.parse(readFileSync(LINKS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write a session link (orchestrator → main, by tmux target).
 */
export function writeLink(orchestratorTarget: string, mainTarget: string): void {
  const links = readLinks();
  links[orchestratorTarget] = mainTarget;
  if (!existsSync(CLAUDE_MUX_DIR)) {
    mkdirSync(CLAUDE_MUX_DIR, { recursive: true });
  }
  const tmpPath = LINKS_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(links, null, 2));
  renameSync(tmpPath, LINKS_PATH);
}
