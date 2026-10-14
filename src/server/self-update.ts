/**
 * `claude-mux update` started from the page (`POST /api/update`), for the
 * Machines view.
 *
 * The update ends by restarting the server that started it, so it cannot be
 * a child that lives and dies with the request. It runs detached, writing its
 * output to a log and its exit code to a file of its own once it is done, and
 * the job is read back from those files: by this server while it lasts, and by
 * the new one after the restart. A systemd unit is left with `KillMode=process`
 * by the update itself, so ending the server's main process leaves the update
 * running; a server started by hand is a parent the detached update outlives.
 *
 * The files live in one directory: `job.json` (when it started, from which
 * version, the shell's pid), `output.log`, and `exit` (the exit code).
 */

import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "../utils/pid.js";
import { writeFileAtomic } from "../utils/atomic-write.js";

export type UpdateState = "running" | "ok" | "failed";

export interface UpdateJob {
  state: UpdateState;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** The version the server ran when the update was started. */
  fromVersion: string;
  /** The end of what the update printed. */
  output: string;
}

/** How much of the update's output a status carries, in bytes. */
const OUTPUT_TAIL = 8_000;

interface JobFile {
  startedAt: number;
  fromVersion: string;
  pid: number | null;
}

/** The last `OUTPUT_TAIL` bytes of the log, read without loading the rest. */
function readTail(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, OUTPUT_TAIL);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * How long an update may run before it counts as failed. Its pid alone cannot
 * say, since after a reboot another process may hold it.
 */
export const UPDATE_DEADLINE_MS = 30 * 60_000;

/**
 * The last update started from `dir`, or null when none was. One whose shell
 * is gone without writing an exit code, or that has run past its deadline,
 * counts as failed.
 */
export function readUpdateJob(
  dir: string,
  isAlive: (pid: number) => boolean = isPidAlive,
  now: () => number = Date.now
): UpdateJob | null {
  const raw = readText(join(dir, "job.json"));
  if (raw === null) return null;
  let job: JobFile;
  try {
    job = JSON.parse(raw);
  } catch {
    return null;
  }
  const output = readTail(join(dir, "output.log"));
  const base = { startedAt: job.startedAt, fromVersion: job.fromVersion, output };
  const exit = readText(join(dir, "exit"));
  if (exit !== null && exit.trim() !== "") {
    const exitCode = Number(exit.trim());
    let finishedAt: number | null = null;
    try {
      finishedAt = statSync(join(dir, "exit")).mtimeMs;
    } catch {
      // Gone between the read and the stat.
    }
    return { ...base, state: exitCode === 0 ? "ok" : "failed", exitCode, finishedAt };
  }
  if (job.pid !== null && isAlive(job.pid) && now() - job.startedAt < UPDATE_DEADLINE_MS) return { ...base, state: "running", exitCode: null, finishedAt: null };
  return { ...base, state: "failed", exitCode: null, finishedAt: null, output: `${output}\n(the update ended without a result)`.trimStart() };
}

/**
 * How this server's own `claude-mux` is run: the script it was started from
 * when that is the CLI (so the update installs with the package manager that
 * owns it), else the one on the PATH.
 */
export function selfCommand(argv: readonly string[] = process.argv, execPath = process.execPath): string[] {
  const script = argv[1] ?? "";
  if (/(^|\/)(cli\.(js|ts)|claude-mux)$/.test(script)) return [execPath, script];
  return ["claude-mux"];
}

export interface StartUpdateOptions {
  dir: string;
  fromVersion: string;
  /** The command to run, `update` appended; `selfCommand()` by default. */
  command?: string[];
  now?: () => number;
}

/**
 * Start an update unless one is running. Answers the job as it stands, and
 * whether this call started it.
 */
export function startUpdate(opts: StartUpdateOptions): { started: boolean; job: UpdateJob } {
  const running = readUpdateJob(opts.dir, undefined, opts.now);
  if (running?.state === "running") return { started: false, job: running };

  mkdirSync(opts.dir, { recursive: true });
  rmSync(join(opts.dir, "exit"), { force: true });
  const startedAt = (opts.now ?? Date.now)();
  const logPath = join(opts.dir, "output.log");
  const log = openSync(logPath, "w");
  const command = [...(opts.command ?? selfCommand()), "update"];
  // The exit code is written by the shell around the update, so it lands even
  // after the server that started it is gone.
  const child = spawn("sh", ["-c", '"$@"; echo $? > "$CLAUDE_MUX_UPDATE_EXIT"', "sh", ...command], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, CLAUDE_MUX_UPDATE_EXIT: join(opts.dir, "exit") },
  });
  closeSync(log);
  // A shell that cannot be started never writes its exit code; this one does.
  child.on("error", (err) => {
    try {
      writeFileSync(join(opts.dir, "exit"), "127");
      writeFileSync(logPath, `could not start the update: ${err.message}\n`);
    } catch {
      // Nothing more to say.
    }
  });
  child.unref();
  const job: JobFile = { startedAt, fromVersion: opts.fromVersion, pid: child.pid ?? null };
  writeFileAtomic(join(opts.dir, "job.json"), JSON.stringify(job));
  return {
    started: true,
    job: { startedAt, fromVersion: opts.fromVersion, state: "running", exitCode: null, finishedAt: null, output: "" },
  };
}
