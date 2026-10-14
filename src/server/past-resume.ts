/**
 * Resuming a past session, and settling a live one (spec #92, "Past and
 * settled sessions"). Both are decided here, apart from tmux and the disk, so
 * the tests can try every case.
 */

import { dirname } from "node:path";

/** What the session list says of a session, as far as resuming and settling it go. */
export interface LiveSession {
  id: string;
  tmux_target?: string | null;
  pane_alive?: boolean;
  state?: string;
  agent?: string | null;
  subagents?: { state?: string }[] | null;
  queue?: unknown[] | null;
}

export type ResumePlan =
  /** It is already running: go to its pane rather than start a second process on one transcript. */
  | { kind: "live"; target: string }
  /** No transcript by that id on this machine. */
  | { kind: "unknown" }
  /** The folder it ran in is gone; `root` is the project's root to offer instead, when one is left. */
  | { kind: "folder-gone"; cwd: string | null; root: string | null }
  | { kind: "start"; cwd: string; transcript: string };

export interface ResumeInput {
  id: string;
  /** The folder the person chose (the root offered when the session's own was gone); null for the session's own. */
  cwd: string | null;
  sessions: readonly LiveSession[];
  /** Its transcript's path, or null when this machine has none. */
  transcript: string | null;
  /** The folder its transcript says it last ran in. */
  ranIn: string | null;
  /** The project roots this machine remembers. */
  projects: readonly string[];
  isDir(path: string): boolean;
}

export function planResume(input: ResumeInput): ResumePlan {
  const live = input.sessions.find((s) => s.id === input.id && s.pane_alive !== false && s.tmux_target);
  if (live?.tmux_target) return { kind: "live", target: live.tmux_target };
  if (!input.transcript) return { kind: "unknown" };
  const want = input.cwd ?? input.ranIn;
  if (want && input.isDir(want)) return { kind: "start", cwd: want, transcript: input.transcript };
  const gone = input.ranIn ?? want;
  return { kind: "folder-gone", cwd: gone, root: gone ? fallbackRoot(gone, input.projects, input.isDir) : null };
}

function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Where a session whose folder is gone can resume: the deepest remembered
 * project that holds that folder and is still there (a removed worktree's
 * repo), else the nearest folder above it that is, short of `/` and the
 * home directory's parent.
 */
export function fallbackRoot(cwd: string, projects: readonly string[], isDir: (path: string) => boolean): string | null {
  const project = projects
    .filter((p) => p !== cwd && under(cwd, p) && isDir(p))
    .sort((a, b) => b.length - a.length)[0];
  if (project) return project;
  for (let dir = dirname(cwd); dir.split("/").filter(Boolean).length >= 2; dir = dirname(dir)) {
    if (isDir(dir)) return dir;
  }
  return null;
}

/**
 * Whether settling a session also ends it: Claude Code sitting idle at its
 * prompt, with nothing queued for it and no subagent at work, is ended and its
 * pane closed. Anything else (a turn running, a question open, another agent)
 * is left running and only moved to Settled.
 */
export function settleCloses(session: LiveSession): boolean {
  if (session.pane_alive === false || !session.tmux_target) return false;
  if ((session.agent ?? "claude") !== "claude") return false;
  if (session.state !== "idle") return false;
  if (session.queue?.length) return false;
  return !session.subagents?.some((a) => a.state === "running");
}
