/**
 * Quit Claude Code and reopen the same conversation in the same pane.
 *
 * Restarting is how Claude Code picks up an update it has already downloaded
 * and re-reads skills, plugins and hooks, so this exists as an action rather
 * than a kill-and-relaunch the user has to do by hand. The relaunch must be
 * the same launch: `--dangerously-skip-permissions`, a `--model`, whatever the
 * pane was started with. Nothing on disk records that, but the process table
 * does, so the running process's own argv is read back and replayed with
 * `--resume <id>`.
 *
 * A pane comes in two shapes. One launched by hand has a shell under Claude
 * Code, which gets the pane back when the process exits and is already in the
 * launch directory `--resume` looks the session up under; the command is typed
 * there. One started with a command — the dashboard's, or a wrapper's — would
 * close when that command exits; tmux's `respawn-pane` replaces the process in
 * place instead.
 *
 * The session's own file does not survive the trip: the old process's
 * SessionEnd hook deletes it before the new one's SessionStart can read it
 * back. What a person gave the session — its name — is put back once the new
 * process has registered.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";
import { setTimeout as delay } from "timers/promises";

import { getSession, updateSession, type Session } from "../db/sessions-json.js";
import { runTmux } from "../tmux/pane.js";
import { shellQuote } from "../utils/shell.js";
import { terminate } from "../utils/pid.js";

const SHELL_TIMEOUT_MS = 5_000;
const RESUME_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

export type RestartOutcome = { ok: true; command: string } | { ok: false; error: string };

/**
 * The argv Claude Code was started with, minus any resume flag it already
 * carried, or null when the process is gone or not readable. `/proc` keeps
 * the arguments exactly; `ps` is the fallback where there is no `/proc`.
 */
export function readLaunchArgs(pid: number): string[] | null {
  let argv: string[];
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0");
  } catch {
    try {
      const line = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      argv = line.trim().split(/\s+/);
    } catch {
      return null;
    }
  }
  argv = argv.filter((a) => a.length > 0);
  return argv.length === 0 ? null : stripResumeFlags(argv);
}

/**
 * Drops `--resume [id]`, `-r [id]` and `--continue`/`-c` so the replay names
 * exactly one session. `--resume` may be bare (it opens a picker) or carry an
 * id; a following token that looks like a flag is kept.
 */
export function stripResumeFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--continue" || arg === "-c") continue;
    if (arg === "--resume" || arg === "-r") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    if (arg.startsWith("--resume=")) continue;
    out.push(arg);
  }
  return out;
}

/**
 * The argv that reopens `session`, or null when the running launch cannot be
 * read — a guess would silently drop its flags. The launcher's argv[0] can be
 * an absolute path to a versioned binary, which an update replaces, so it is
 * reduced to its name for the shell to resolve afresh.
 */
export function buildRestartArgv(session: Pick<Session, "id" | "pid">): string[] | null {
  const launched = readLaunchArgs(session.pid);
  if (!launched) return null;
  return [basename(launched[0]), ...launched.slice(1), "--resume", session.id];
}

async function paneFormat(target: string, format: string): Promise<string[] | null> {
  const out = await runTmux(["display-message", "-p", "-t", target, format]);
  return out === null ? null : out.split("\t");
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(POLL_MS);
  }
  return false;
}

/**
 * Puts back what the hooks cannot: the name the user gave the session, the
 * prompt it was titled after, and its Remote Control link. Runs after the
 * response, once the new process has written the session file.
 */
async function restoreAfterResume(old: Session): Promise<void> {
  const registered = await waitUntil(async () => {
    const now = getSession(old.id);
    return now !== null && now.pid !== old.pid;
  }, RESUME_TIMEOUT_MS);
  if (!registered) return;
  updateSession(old.id, {
    display_name: old.display_name ?? null,
    prompt_text: old.prompt_text,
    rc_url: old.rc_url ?? null,
  });
}

export async function restartClaude(session: Session): Promise<RestartOutcome> {
  const target = session.tmux_target;
  if (!target) return { ok: false, error: "session has no tmux pane" };
  if (!Number.isInteger(session.pid) || session.pid <= 0) {
    return { ok: false, error: "session has no process" };
  }

  // Read the pane and the argv before the process goes away.
  const shape = await paneFormat(
    target,
    "#{pane_pid}\t#{pane_current_path}\t#{pane_start_command}\t#{pane_current_command}"
  );
  if (shape === null) return { ok: false, error: "tmux pane not found" };
  const [panePid, panePath, startCommand, runningCommand] = shape;
  const argv = buildRestartArgv(session);
  if (!argv) return { ok: false, error: "could not read how Claude Code was launched" };
  const command = argv.map(shellQuote).join(" ");

  if (Number(panePid) === session.pid || startCommand !== "") {
    // The pane is its command: replace it in place, as separate arguments so
    // tmux execs it directly and no shell sits between the pane and Claude
    // Code next time. CLAUDECODE is unset for the same reason new-session
    // unsets it: the tmux server's environment may carry a parent session's.
    const ok = await runTmux([
      "respawn-pane",
      "-k",
      "-t",
      target,
      "-c",
      panePath,
      "--",
      "env",
      "-u",
      "CLAUDECODE",
      ...argv,
    ]);
    if (ok === null) return { ok: false, error: "tmux could not respawn the pane" };
    void restoreAfterResume(session);
    return { ok: true, command };
  }

  if (!(await terminate(session.pid))) return { ok: false, error: "Claude Code did not exit" };
  // Whatever the pane runs once Claude Code is gone is the shell to type into.
  const atShell = await waitUntil(async () => {
    const now = await paneFormat(target, "#{pane_current_command}");
    return now !== null && now[0] !== runningCommand;
  }, SHELL_TIMEOUT_MS);
  if (!atShell) return { ok: false, error: "pane did not return to a shell" };
  // C-u clears anything left on the prompt line before the command lands.
  const typed = await runTmux(["send-keys", "-t", target, "C-u", command, "Enter"]);
  if (typed === null) return { ok: false, error: "could not type into the pane" };
  void restoreAfterResume(session);
  return { ok: true, command };
}
