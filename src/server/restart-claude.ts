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
 * A pane comes in two shapes. One launched by hand has a shell under Claude
 * Code, which gets the pane back when the process exits and is already in the
 * launch directory `--resume` looks the session up under; the command is typed
 * there. One the dashboard spawned runs Claude Code as its root process, so
 * its exit would close the pane; tmux's `respawn-pane` replaces the process in
 * place instead.
 */

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";
import { setTimeout as delay } from "timers/promises";
import { promisify } from "util";

import type { Session } from "../db/sessions-json.js";
import { terminate } from "../utils/pid.js";

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "nu"]);

export type RestartOutcome = { ok: true; command: string } | { ok: false; error: string };

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

async function tmux(...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", args, { encoding: "utf-8", timeout: 2_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function waitForShell(target: string): Promise<boolean> {
  const deadline = Date.now() + SHELL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cmd = await tmux("display-message", "-p", "-t", target, "#{pane_current_command}");
    if (cmd !== null && SHELLS.has(cmd)) return true;
    await delay(POLL_MS);
  }
  return false;
}

export async function restartClaude(session: Session): Promise<RestartOutcome> {
  const target = session.tmux_target;
  if (!target) return { ok: false, error: "session has no tmux pane" };
  if (!Number.isInteger(session.pid) || session.pid <= 0) {
    return { ok: false, error: "session has no process" };
  }

  // Read the pane and the argv before the process goes away.
  const shape = await tmux(
    "display-message",
    "-p",
    "-t",
    target,
    "#{pane_pid}\t#{pane_current_path}"
  );
  if (shape === null) return { ok: false, error: "tmux pane not found" };
  const [panePid, panePath] = shape.split("\t");
  const command = buildRestartCommand(session);

  if (Number(panePid) === session.pid) {
    // Claude Code is the pane: replace it in place. The dashboard launches
    // with CLAUDECODE unset for the same reason (see new-session).
    const ok = await tmux(
      "respawn-pane",
      "-k",
      "-t",
      target,
      "-c",
      panePath,
      `env -u CLAUDECODE ${command}`
    );
    return ok === null
      ? { ok: false, error: "tmux could not respawn the pane" }
      : { ok: true, command };
  }

  if (!(await terminate(session.pid))) return { ok: false, error: "Claude Code did not exit" };
  if (!(await waitForShell(target))) return { ok: false, error: "pane did not return to a shell" };
  // C-u clears anything left on the prompt line before the command lands.
  const typed = await tmux("send-keys", "-t", target, "C-u", command, "Enter");
  return typed === null
    ? { ok: false, error: "could not type into the pane" }
    : { ok: true, command };
}
