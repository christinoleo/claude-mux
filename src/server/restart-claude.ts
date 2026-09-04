/**
 * Quit Claude Code and reopen the same conversation in the same pane.
 *
 * Restarting is how Claude Code picks up an update it has already downloaded
 * and re-reads skills, plugins and hooks, so this exists as an action rather
 * than a kill-and-relaunch the user has to do by hand. The relaunch must be
 * the same launch: `--dangerously-skip-permissions`, a `--model`, whatever the
 * pane was started with. Nothing on disk records that, but `/proc` does, so the
 * running process's own argv is read back and replayed with `--resume <id>`.
 *
 * The shell the pane returns to is the one Claude Code was launched from, so it
 * already sits in the launch directory — the one `--resume` looks the session
 * up under. No `cd` is sent; it would only ever move away from the right place.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";

import type { Session } from "../db/sessions-json.js";

const EXIT_TIMEOUT_MS = 5_000;
const SHELL_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "nu"]);

export type RestartOutcome =
  | { ok: true; command: string }
  | { ok: false; error: string };

/**
 * The argv Claude Code was started with, minus any resume flag it already
 * carried, or null when the process is gone or not readable.
 */
export function readLaunchArgs(pid: number): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    return null;
  }
  const argv = raw.split("\0").filter((a) => a.length > 0);
  if (argv.length === 0) return null;
  return stripResumeFlags(argv);
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

/** POSIX single-quoting; safe for any byte a shell might otherwise read. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./=:@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line that reopens `session`. The launcher's argv[0] can be an
 * absolute path to a versioned binary, which an update replaces, so it is
 * reduced to its name and left for the shell to resolve afresh.
 */
export function buildRestartCommand(session: Pick<Session, "id" | "pid">): string {
  const launched = readLaunchArgs(session.pid) ?? ["claude"];
  const argv = [basename(launched[0]), ...launched.slice(1), "--resume", session.id];
  return argv.map(shellQuote).join(" ");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(POLL_MS);
  }
  return check();
}

function paneCommand(target: string): string | null {
  try {
    return execFileSync("tmux", ["display-message", "-p", "-t", target, "#{pane_current_command}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Asks the process to quit, gives it a moment to restore the terminal, and
 * only then forces it. Claude Code exits cleanly on SIGTERM; SIGKILL would
 * leave the pane in raw mode with the alternate screen still up.
 */
async function stopProcess(pid: number): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isAlive(pid);
  }
  if (await waitUntil(() => !isAlive(pid), EXIT_TIMEOUT_MS)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Died in the meantime.
  }
  return waitUntil(() => !isAlive(pid), 1_000);
}

export async function restartClaude(session: Session): Promise<RestartOutcome> {
  const target = session.tmux_target;
  if (!target) return { ok: false, error: "session has no tmux pane" };
  if (!Number.isInteger(session.pid) || session.pid <= 0) {
    return { ok: false, error: "session has no process" };
  }

  // Read argv before the process goes away; it is the only copy.
  const command = buildRestartCommand(session);

  if (!(await stopProcess(session.pid))) {
    return { ok: false, error: "Claude Code did not exit" };
  }

  const atShell = await waitUntil(() => {
    const cmd = paneCommand(target);
    return cmd !== null && SHELLS.has(cmd);
  }, SHELL_TIMEOUT_MS);
  if (!atShell) return { ok: false, error: "pane did not return to a shell" };

  try {
    // Clears anything left on the prompt line before the command lands.
    execFileSync("tmux", ["send-keys", "-t", target, "C-u", command, "Enter"], { stdio: "ignore" });
  } catch {
    return { ok: false, error: "could not type into the pane" };
  }
  return { ok: true, command };
}
