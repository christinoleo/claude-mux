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

import { execFile, execFileSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { setTimeout as delay } from "timers/promises";
import { promisify } from "util";

import { getSession, updateSession, type Session } from "../db/sessions-json.js";
import { capturePaneContentAsync, isBangRunning, readUpdateNotice, runTmux, stripAnsi } from "../tmux/pane.js";
import { readTailLines } from "../transcript/context-peek.js";
import { resolveTranscriptPath } from "../transcript/tailer.js";
import type { UpgradeStatus } from "../types/ws-messages.js";
import { descendants, readProcessTable, type ProcessRow } from "../utils/processes.js";
import { shellQuote } from "../utils/shell.js";
import { terminate } from "../utils/pid.js";

const execFileAsync = promisify(execFile);

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, pollMs = POLL_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(pollMs);
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

/**
 * How long a `!` command gets to be seen starting (a quick one may never be),
 * how long it may run before the restart is given up on, and how often it is
 * looked at in between; an upgrade takes tens of seconds.
 */
export type BangTiming = { startMs: number; timeoutMs: number; pollMs: number };
const BANG_TIMING: BangTiming = { startMs: 3_000, timeoutMs: 5 * 60_000, pollMs: 1_000 };

/** Where `bangFinished()` looks: the process table first, the pane where there is none. */
export type BangProbe = {
  processes: () => Promise<ProcessRow[] | null>;
  pane: () => Promise<string | null>;
};

/**
 * Whether the `!` command is still running. Claude Code runs it in a shell of
 * its own, a child whose argv carries the command's words (`bash -c … eval
 * '<command>' …`), and the command itself sits below that shell; either one
 * still there means it runs. The pane is read only where the process table
 * cannot be, since what it draws while a command prints is the command's own
 * output, not "Running…".
 */
async function bangRunning(pid: number, command: string, probe: BangProbe): Promise<boolean> {
  const rows = await probe.processes();
  if (rows) return descendants(rows, pid).some((row) => row.args.includes(command));
  return isBangRunning((await probe.pane()) ?? "");
}

/** Resolves once the `!` command has ended, or false at the timeout. */
export async function bangFinished(
  pid: number,
  command: string,
  probe: BangProbe,
  timing: BangTiming = BANG_TIMING
): Promise<boolean> {
  const running = () => bangRunning(pid, command, probe);
  // A quick command may never be seen running, so not seeing it start is no failure.
  await waitUntil(running, timing.startMs, timing.pollMs / 10);
  const end = Date.now() + timing.timeoutMs;
  while (Date.now() < end) {
    if (!(await running())) return true;
    await delay(timing.pollMs);
  }
  return false;
}

/**
 * The version `claude` reports on the session's own PATH: the binary a
 * restart would start, which is the one an upgrade has to change. Read off
 * the running process's environment where `/proc` has it; null when it will
 * not answer.
 */
export async function claudeVersion(session: Pick<Session, "pid" | "cwd">): Promise<string | null> {
  let path = process.env.PATH;
  try {
    const env = readFileSync(`/proc/${session.pid}/environ`, "utf-8").split("\0");
    path = env.find((v) => v.startsWith("PATH="))?.slice(5) ?? path;
  } catch {
    /* no /proc: the server's own PATH is the best guess */
  }
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      cwd: session.cwd,
      env: { ...process.env, PATH: path },
      timeout: 15_000,
    });
    return /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** How much of the transcript's end is searched for the command's output. */
const OUTPUT_TAIL_BYTES = 256 * 1024;
/** How many of the output's last lines are kept to show. */
const OUTPUT_LINES = 20;

/**
 * What the last `!` command printed, from the lines of a transcript: Claude
 * Code records it as a user entry `<bash-stdout>…</bash-stdout><bash-stderr>…`,
 * which, unlike the pane, it never folds. Progress bars leave their escapes in,
 * so those go, and only the last lines are kept.
 */
export function lastBangOutput(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("<bash-stdout>")) continue;
    let body: unknown;
    try {
      body = JSON.parse(lines[i])?.message?.content;
    } catch {
      continue;
    }
    if (typeof body !== "string") continue;
    const part = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1] ?? "";
    const text = stripAnsi([part("bash-stdout"), part("bash-stderr")].join("\n"))
      .split(/\r?\n/)
      .map((line) => (line.split("\r").filter(Boolean).at(-1) ?? "").trimEnd())
      .filter((line) => line.length > 0);
    return text.slice(-OUTPUT_LINES).join("\n");
  }
  return null;
}

function readBangOutput(session: Session): string | null {
  const path = resolveTranscriptPath(session, session.id);
  if (!path) return null;
  try {
    return lastBangOutput(readTailLines(path, statSync(path).size, OUTPUT_TAIL_BYTES));
  } catch {
    return null;
  }
}

/**
 * How the last upgrade asked of a session stands, until it restarts the
 * session or a while after it gave up. `running` holds while the command
 * runs; the others say why there was no restart, with what the command
 * printed. Kept in globalThis: in dev the route and the poll load this module
 * separately, and the poll is what puts it on the broadcast.
 */
const upgrades = ((globalThis as typeof globalThis & {
  __claudeMuxUpgrades?: Map<string, UpgradeStatus>;
}).__claudeMuxUpgrades ??= new Map<string, UpgradeStatus>());
/** How long the reason an upgrade did not restart stays on show. */
const UPGRADE_RESULT_MS = 10 * 60_000;

/** The session's upgrade as it stands, or null when none is running or lately ended without a restart. */
export function upgradeStatus(sessionId: string): UpgradeStatus | null {
  const status = upgrades.get(sessionId);
  if (status && status.state !== "running" && Date.now() - status.at > UPGRADE_RESULT_MS) {
    upgrades.delete(sessionId);
    return null;
  }
  return status ?? null;
}

/**
 * Run the upgrade Claude Code's own notice asks for, then restart into it.
 *
 * The command is typed into Claude Code itself with a leading `!`, its way of
 * running a shell line: that works whatever the pane was started with, runs as
 * the user in the session's own environment, and leaves the output in the
 * conversation where it can be read. Nothing reports such a command ending, so
 * the shell Claude Code runs it in is watched until it exits.
 *
 * It answers as soon as the command is typed and does the waiting and the
 * restart afterwards: the server drops a request that sits idle for ten
 * seconds, and an upgrade takes longer. The restart happens only when the
 * version on the session's PATH changed; a restart into the same version
 * would show the same notice again, so instead the status says the upgrade
 * did nothing and carries what the command printed.
 */
export async function upgradeThenRestart(session: Session): Promise<RestartOutcome> {
  const target = session.tmux_target;
  if (!target) return { ok: false, error: "session has no tmux pane" };
  if (upgradeStatus(session.id)?.state === "running") {
    return { ok: false, error: "an upgrade is already running here" };
  }
  if (session.state !== "idle") {
    return { ok: false, error: "Claude Code is busy; upgrade once it is waiting for you" };
  }
  // Read off the pane here, never taken from the request: only a known upgrade command is typed.
  const [pane, before] = await Promise.all([capturePaneContentAsync(target), claudeVersion(session)]);
  const command = readUpdateNotice(pane ?? "")?.command;
  if (!command) return { ok: false, error: "the pane shows no upgrade command claude-mux can run" };
  // C-u clears a draft or a suggestion first: `!` only means "shell" at the start of the box.
  if ((await runTmux(["send-keys", "-t", target, "C-u", `!${command}`, "Enter"])) === null) {
    return { ok: false, error: "could not type into the pane" };
  }

  upgrades.set(session.id, { state: "running", command, at: Date.now() });
  const settle = (state: Exclude<UpgradeStatus["state"], "running">, message: string) => {
    console.warn(`[upgrade] ${target}: ${message}`);
    upgrades.set(session.id, { state, command, at: Date.now(), message, output: readBangOutput(session) });
  };
  void (async () => {
    try {
      const probe: BangProbe = {
        processes: readProcessTable,
        pane: () => capturePaneContentAsync(target),
      };
      if (!(await bangFinished(session.pid, command, probe))) {
        return settle("timeout", `"${command}" was still running after five minutes, so Claude Code was not restarted`);
      }
      const after = await claudeVersion(session);
      if (before !== null && after === before) {
        return settle("unchanged", `"${command}" did not change Claude Code's version (still ${after}), so it was not restarted`);
      }
      // The file is read again: the command's output started a turn of its own.
      const outcome = await restartClaude(getSession(session.id) ?? session);
      if (!outcome.ok) return settle("failed", `the upgrade ran but the restart failed: ${outcome.error}`);
      upgrades.delete(session.id);
    } catch (err) {
      settle("failed", `the upgrade stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return { ok: true, command };
}
