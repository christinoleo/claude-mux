/**
 * The worker queue (#200, map #177): one queue of ready issues across every
 * project and machine, run by the server in place of a maestro daemon per repo.
 *
 * The queue is what `EventPoller.readyIssues()` holds: issues Leo marked
 * `ready-for-agent` in a project whose `issue-ready` event starts a session.
 * Every machine reads the same GitHub, so every machine sees the same queue;
 * each decides on its own whether it starts the next one, and GitHub settles
 * which machine got it. After every sweep the queue here:
 *
 * 1. Reaps its own workers. A worker whose issue closed has its tmux window
 *    killed and its worktree and branch removed, as the daemon did. One whose
 *    window vanished while the issue is still open is put back once (its
 *    `in-progress` taken off) and asks for help the second time.
 * 2. Starts workers while the machine has room. The limit is the machine's
 *    alone (#185: 8 on `omarchy`, set on the Events screen) and counts every
 *    live worker session here, a daemon's too. A start is held, never a
 *    running worker stopped, while free memory is under a floor (2.5 GiB) or
 *    memory pressure is over a ceiling (#181); each start in one sweep counts
 *    against the free memory read at its beginning, since a worker grows into
 *    its share minutes after it starts.
 *
 * An issue is taken only when it is open, unblocked, not `in-progress`,
 * `needs-help`, `ready-for-human` or `hold`, and may run here: its project's
 * placement list (`src/worker-placement.ts`) names this machine or is empty,
 * and no machine that keeps its projects (`engage`) holds it, unless that is
 * this one. `stop-at-pr` passes to the worker, which opens its PR and stops.
 *
 * Two machines may go for one issue in the same minute. Each re-reads it,
 * posts a claim comment carrying a marker, labels it `in-progress`, waits a
 * moment and reads the markers back: the earliest claim since the last
 * release, and no older than ten minutes before its own, wins, and the loser
 * deletes its own. A release marker is posted whenever this queue puts an
 * issue back, and the window covers an issue that came back any other way.
 *
 * The switch is per machine and off at first, so this coexists with the
 * per-repo daemons until each project moves over. A project still run by a
 * daemon should not also start sessions here: the daemon claims by label
 * alone and posts no marker.
 */

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";
import { readProcessTable, type ProcessRow } from "../utils/processes.js";
import { shellQuote } from "../utils/shell.js";
import { tmuxServerRunning } from "../tmux/server.js";
import type { ReadyIssue } from "./github-events.js";
import { HOLD, NEEDS_HELP, STOP_AT_PR } from "./github.js";
import { git } from "./git.js";
import { placeName } from "../worker-placement.js";

export const IN_PROGRESS = "in-progress";
export const READY_FOR_HUMAN = "ready-for-human";

/** What a worker takes, typically, once it has grown (#181): counted against free memory for each start in a sweep. */
export const WORKER_ESTIMATE_GIB = 1.4;
/** How long a claim waits for the other machine's comment to be readable before the markers are compared. */
export const CLAIM_SETTLE_MS = 3_000;
/** How many times the claims are read back before the queue gives up on knowing who won. */
const MARKER_READS = 3;
/**
 * How far back a claim can still beat a newer one. Two machines race within
 * seconds; an older claim is one whose issue came back to the queue some way
 * that posted no release (a person cleared needs-help, the issue was
 * reopened, a machine died), and it must not win forever.
 */
export const CLAIM_WINDOW_MS = 10 * 60_000;
const LOG_LIMIT = 100;

export const CLAIM_MARK = "<!-- claude-mux:claim ";
export const RELEASE_MARK = "<!-- claude-mux:release -->";

// ── settings ────────────────────────────────────────────────────────────────

export interface QueueSettings {
  /** Whether this machine starts workers at all. */
  enabled: boolean;
  /** How many workers may run here at once. */
  limit: number;
  /** A start is held while MemAvailable is under this. */
  minFreeGiB: number;
  /** A start is held while `full avg60` memory pressure is over this, in percent. */
  maxPressure: number;
}

export const DEFAULT_SETTINGS: QueueSettings = { enabled: false, limit: 8, minFreeGiB: 2.5, maxPressure: 10 };

const BOUNDS: Record<Exclude<keyof QueueSettings, "enabled">, [number, number]> = {
  limit: [0, 64],
  minFreeGiB: [0, 256],
  maxPressure: [0, 100],
};

/** A settings patch as a request sends it, checked; a string says what is wrong. */
export function parseSettingsPatch(raw: unknown): Partial<QueueSettings> | string {
  if (!raw || typeof raw !== "object") return "settings must be an object";
  const r = raw as Record<string, unknown>;
  const patch: Partial<QueueSettings> = {};
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== "boolean") return "enabled must be true or false";
    patch.enabled = r.enabled;
  }
  for (const [key, [min, max]] of Object.entries(BOUNDS) as [keyof typeof BOUNDS, [number, number]][]) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return `${key} must be a number from ${min} to ${max}`;
    if (key === "limit" && !Number.isInteger(v)) return "limit must be a whole number";
    patch[key] = v;
  }
  return patch;
}

// ── what is kept across restarts ─────────────────────────────────────────────

export interface WorkerRecord {
  repo: string;
  number: number;
  title: string;
  url: string;
  root: string;
  /** tmux's id for the window, `@12`, which stays the window's however it is moved. */
  window: string;
  /**
   * The tmux server's pid and the window's name when it started: ids start
   * again from `@0` when the server restarts, so an id alone could name
   * someone else's window.
   */
  server: string;
  name: string;
  /** Where it was started, `session:name`, for the screen. */
  target: string;
  startedAt: number;
  /** When the queue first saw the issue ready; absent on a record from before the history. */
  queuedAt?: number | null;
  /** The most its session's processes held at once, in GiB. */
  peakGiB?: number | null;
  /** What its transcripts cost so far, subagents' too. */
  spendUsd?: number | null;
}

/** How a worker ended. */
export type RunResult = "merged" | "closed" | "help" | "lost" | "stopped";

/** A worker that ended, as the history keeps it (#201). */
export interface WorkerRun {
  repo: string;
  number: number;
  title: string;
  url: string;
  machine: string;
  queuedAt: number | null;
  startedAt: number;
  endedAt: number;
  result: RunResult;
  peakGiB: number | null;
  spendUsd: number | null;
}

/** How long the history keeps a run: the longest period the screen shows. */
export const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;

export interface HistoryStore {
  load(): WorkerRun[];
  append(run: WorkerRun): void;
}

/**
 * The runs in `worker-history.json`, kept for `HISTORY_DAYS` and written only
 * when one ends. Only this process writes the file, so it is read once.
 */
export function fileHistoryStore(
  path: string = join(CLAUDE_MUX_DIR, "worker-history.json"),
  now: () => number = Date.now
): HistoryStore {
  let runs: WorkerRun[] | null = null;
  const load = (): WorkerRun[] => {
    if (runs) return runs;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as { runs?: unknown };
      runs = Array.isArray(raw.runs) ? (raw.runs as WorkerRun[]) : [];
    } catch {
      runs = [];
    }
    return runs;
  };
  return {
    load,
    append(run) {
      const since = now() - (HISTORY_DAYS + 1) * DAY_MS;
      runs = [...load().filter((r) => r.endedAt >= since), run];
      writeFileAtomic(path, JSON.stringify({ v: 1, runs }));
    },
  };
}

export interface QueueEvent {
  at: number;
  repo: string;
  number: number;
  what: string;
}

export interface QueueFile {
  v: 1;
  settings: QueueSettings;
  workers: WorkerRecord[];
  /** Issues put back once after their worker vanished: the second time asks for help. */
  retried: string[];
  log: QueueEvent[];
  /** When each issue now in the queue was first seen there, by `repo#n`: what a run's wait is counted from. */
  seen?: Record<string, number>;
}

export interface QueueStore {
  load(): QueueFile;
  save(file: QueueFile): void;
}

export function fileQueueStore(path: string = join(CLAUDE_MUX_DIR, "worker-queue.json")): QueueStore {
  return {
    load() {
      let raw: Partial<QueueFile> = {};
      try {
        raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<QueueFile>;
      } catch {
        // Missing or torn: off, and nothing started.
      }
      const settings = { ...DEFAULT_SETTINGS };
      const patch = parseSettingsPatch(raw.settings ?? {});
      if (typeof patch === "object") Object.assign(settings, patch);
      return {
        v: 1,
        settings,
        workers: Array.isArray(raw.workers) ? raw.workers : [],
        retried: Array.isArray(raw.retried) ? raw.retried : [],
        log: Array.isArray(raw.log) ? raw.log : [],
        seen: raw.seen && typeof raw.seen === "object" ? raw.seen : {},
      };
    },
    save(file) {
      writeFileAtomic(path, JSON.stringify(file, null, 2));
    },
  };
}

// ── what the queue reads and does ────────────────────────────────────────────

export interface IssueNow {
  open: boolean;
  labels: string[];
  /** GitHub's `state_reason` once closed: `completed` or `not_planned`. */
  reason?: string | null;
}

export interface Marker {
  id: number;
  body: string;
  /** When it was posted, in ms. */
  at: number;
}

/** GitHub, as the queue uses it. Every call answers null or false when it could not. */
export interface QueueGithub {
  issue(repo: string, number: number): Promise<IssueNow | null>;
  /** Posts a comment; answers its id. */
  comment(repo: string, number: number, body: string): Promise<number | null>;
  deleteComment(repo: string, id: number): Promise<boolean>;
  /** The issue's comments that carry a claude-mux marker, oldest first. */
  markers(repo: string, number: number): Promise<Marker[] | null>;
  addLabel(repo: string, number: number, label: string): Promise<boolean>;
  removeLabel(repo: string, number: number, label: string): Promise<boolean>;
}

/** Runs `tmux` with these arguments. */
export type TmuxRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;
/** Runs `git -C <cwd>` with these arguments. */
export type GitRunner = (cwd: string, args: string[]) => Promise<boolean>;

export interface MemoryReading {
  /** MemTotal, in GiB; null where it cannot be read. */
  totalGiB?: number | null;
  /** MemAvailable, in GiB; null where it cannot be read. */
  availableGiB: number | null;
  /** `full avg60` from `/proc/pressure/memory`, in percent; null where there is none. */
  pressure: number | null;
}

/** A live session on this machine that counts against the limit, as the hooks recorded it. */
export interface LiveWorker {
  issue: number | null;
  cwd: string | null;
  /** The session's id, which the page finds it by in its machine's broadcast. */
  id?: string;
  /** Claude Code's pid: its process tree is the worker's memory. */
  pid?: number | null;
  transcript?: string | null;
}

/** A running worker as the screen shows it: its record, and what its session holds now. */
export interface WorkerView extends WorkerRecord {
  sessionId: string | null;
  memGiB: number | null;
  /** Whether it waits on a person: its issue is `needs-help`. */
  wants: boolean;
  stopAtPr: boolean;
}

/** A live worker session this queue did not start (a daemon's), which counts against the limit. */
export interface OtherWorker {
  issue: number | null;
  cwd: string | null;
  sessionId: string | null;
  memGiB: number | null;
}

/** Whether a session counts against the machine's limit: a worker's, or a Trigger's Run. */
export function countsAgainstLimit(s: { maestro_role?: string | null; run_id?: string | null }): boolean {
  return s.maestro_role === "worker" || !!s.run_id;
}

export interface QueueDeps {
  store: QueueStore;
  /** This machine's name, as placement lists it. */
  machine: () => string;
  /** This machine's id, written into its claims. */
  machineId: string;
  ready: () => ReadyIssue[];
  github: QueueGithub;
  tmux: TmuxRunner;
  git: GitRunner;
  memory: () => MemoryReading;
  liveWorkers: () => LiveWorker[];
  /** The project's placement list, null for any machine. */
  placement: (repo: string) => string[] | null;
  /** The name of a machine that keeps its projects and holds this one, other than this machine; null for none. */
  keptBy: (repo: string) => string | null;
  /** Each process tree's resident memory in GiB, by its root pid; missing where it could not be read. */
  measure?: (pids: number[]) => Promise<Map<number, number>>;
  /** What a session's transcripts cost so far. */
  spend?: (transcript: string) => Promise<number | null>;
  /** Where ended runs are kept; none in a test that does not ask. */
  history?: HistoryStore;
  /** The command a worker runs, issue number given; the environment is put before it. */
  workerCommand?: (issue: number, stopAtPr: boolean) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What kind of thing an issue waits for, so the screen can say it plainly.
 * `running` (a worker owns it or asked for help) and `closed` are not waiting
 * at all, and the screen leaves them out of the queue.
 */
export type WaitKind = "slot" | "memory" | "blocked" | "taken" | "running" | "closed" | "placed" | "off" | "github";

/** Why a ready issue is not running here, for the screen. */
export interface WaitingIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  why: string;
  kind: WaitKind;
  /** When the queue first saw it ready. */
  since: number | null;
}

export interface QueueStatus {
  machine: string;
  settings: QueueSettings;
  running: number;
  memory: MemoryReading;
  /** Why no start goes ahead now, null when one would. */
  hold: string | null;
  workers: WorkerView[];
  others: OtherWorker[];
  waiting: WaitingIssue[];
  log: QueueEvent[];
  lastTickAt: number | null;
  lastError: string | null;
}

export function claimBody(machineId: string, machine: string): string {
  return `${CLAIM_MARK}${machineId} -->\nclaude-mux on **${machine}** is starting a worker on this issue.`;
}

/**
 * The claim that stands against `mine`: the earliest posted since the last
 * release and no more than `CLAIM_WINDOW_MS` before it. Null when `mine`
 * cannot be read back yet, since then nothing is known.
 */
export function winningClaim(markers: readonly Marker[], mine: number): Marker | null {
  const sorted = [...markers].sort((a, b) => a.id - b.id);
  const own = sorted.find((m) => m.id === mine);
  if (!own) return null;
  let since = 0;
  sorted.forEach((m, i) => {
    if (m.body.includes(RELEASE_MARK)) since = i + 1;
  });
  return (
    sorted.slice(since).find((m) => m.body.includes(CLAIM_MARK) && m.at >= own.at - CLAIM_WINDOW_MS) ?? null
  );
}

/** The machine id a claim names. */
export function claimant(marker: Marker): string | null {
  const at = marker.body.indexOf(CLAIM_MARK);
  if (at < 0) return null;
  return marker.body.slice(at + CLAIM_MARK.length).split(/\s/)[0] || null;
}

/** Text as a tmux window name's part: lower case, dashes, at most `max` characters. */
export function slug(text: string, max = 30): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");
}

export function defaultWorkerCommand(issue: number, stopAtPr: boolean): string {
  const prompt = `/ak:maestro-worker ${issue}${stopAtPr ? ` ${STOP_AT_PR}: open the pull request and stop there; do not merge it` : ""}`;
  return `claude --model opus --dangerously-skip-permissions ${shellQuote(prompt)}`;
}

/** A window as `list-windows` prints it with `WINDOW_FORMAT`, and as a record names it. */
export const WINDOW_FORMAT = "#{pid} #{window_id} #{window_name}";

/** Every window tmux has open, as `WINDOW_FORMAT` prints it; null when tmux could not say (then nothing counts as vanished). */
export async function listWindows(tmux: TmuxRunner): Promise<Set<string> | null> {
  const res = await tmux(["list-windows", "-a", "-F", WINDOW_FORMAT]);
  if (!res.ok) {
    // No server at all (no socket, or one nobody answers on) means no window survived; any other error says nothing.
    return /no server running|No such file or directory|Connection refused/.test(res.stdout) ? new Set() : null;
  }
  return new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
}

/**
 * Open a detached window running `command` in the tmux session `session`,
 * creating the session if it is not there. Returns the window's line as
 * `WINDOW_FORMAT` prints it, or null when tmux did not open one.
 */
export async function openWindow(tmux: TmuxRunner, session: string, name: string, cwd: string, command: string): Promise<string | null> {
  const has = await tmux(["has-session", "-t", `=${session}`]);
  const args = has.ok
    ? ["new-window", "-d", "-P", "-F", WINDOW_FORMAT, "-t", `=${session}:`, "-n", name, "-c", cwd, command]
    : ["new-session", "-d", "-P", "-F", WINDOW_FORMAT, "-s", session, "-n", name, "-c", cwd, command];
  const res = await tmux(args);
  const line = res.stdout.trim().split("\n")[0];
  return res.ok && line.split(" ")[1]?.startsWith("@") ? line : null;
}
function windowKey(w: Pick<WorkerRecord, "server" | "window" | "name">): string {
  return `${w.server} ${w.window} ${w.name}`;
}

/** The tmux session a project's workers are started in. */
export function queueSessionName(repo: string): string {
  return `queue-${repo.split("/")[1].replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The labels that keep an issue from being taken, each with why, for the screen. */
const TAKEN_WHY: Record<string, { why: string; kind: WaitKind }> = {
  [IN_PROGRESS]: { why: "A worker owns it", kind: "running" },
  [NEEDS_HELP]: { why: "Its worker asked for help", kind: "running" },
  [READY_FOR_HUMAN]: { why: "A person's task", kind: "taken" },
  [HOLD]: { why: "On hold", kind: "taken" },
};

/** Why a label keeps an issue from being taken, or null. */
function takenBy(labels: readonly string[]): { why: string; kind: WaitKind } | null {
  return Object.entries(TAKEN_WHY).find(([label]) => labels.includes(label))?.[1] ?? null;
}

/** Why the machine's limit or memory brake holds a start back now, or null when one may go ahead. */
function limitHold(settings: QueueSettings, running: number, memory: MemoryReading): { why: string; kind: WaitKind } | null {
  if (running >= settings.limit) return { why: `At the limit: ${running} of ${settings.limit} running`, kind: "slot" };
  const free = memory.availableGiB;
  if (free !== null && free < settings.minFreeGiB) {
    return { why: `Held: ${free.toFixed(1)} GiB free, under ${settings.minFreeGiB} GiB`, kind: "memory" };
  }
  if (memory.pressure !== null && memory.pressure > settings.maxPressure) {
    return { why: `Held: memory pressure ${memory.pressure.toFixed(1)}%, over ${settings.maxPressure}%`, kind: "memory" };
  }
  return null;
}

/** How a run that ended with its issue closed is counted: closed as not planned is no merge. */
function closedResult(now: IssueNow): RunResult {
  return now.reason === "not_planned" ? "closed" : "merged";
}

const issueKey = (i: { repo: string; number: number }) => `${i.repo}#${i.number}`;

export class WorkerQueue {
  private file: QueueFile;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running: Promise<void> | null = null;
  private again = false;
  private waiting: WaitingIssue[] = [];
  private hold: string | null = null;
  private memoryNow: MemoryReading = { availableGiB: null, pressure: null };
  private runningCount = 0;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  /** What each of this queue's workers holds now, by `repo#n`, read on every pass. */
  private live = new Map<string, { sessionId: string | null; memGiB: number | null; labels: string[] }>();
  private others: OtherWorker[] = [];

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.file = deps.store.load();
  }

  update(patch: Partial<QueueSettings>): void {
    this.file.settings = { ...this.file.settings, ...patch };
    this.save();
  }

  status(): QueueStatus {
    return {
      machine: this.deps.machine(),
      settings: this.file.settings,
      running: this.runningCount,
      memory: this.memoryNow,
      hold: this.hold,
      workers: this.file.workers.map((w) => {
        const live = this.live.get(issueKey(w));
        return {
          ...w,
          sessionId: live?.sessionId ?? null,
          memGiB: live?.memGiB ?? null,
          wants: live?.labels.includes(NEEDS_HELP) ?? false,
          stopAtPr: live?.labels.includes(STOP_AT_PR) ?? false,
        };
      }),
      others: this.others,
      waiting: this.waiting,
      log: this.file.log,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  /**
   * Whether a session started by something other than the queue (a Trigger's
   * Run) may start now, under the same limit and memory brake. The switch is
   * left out: it says whether this machine takes issues off GitHub, and a
   * Trigger was set up on this machine on purpose. `starting` counts sessions
   * already started whose hooks have not reported yet.
   */
  room(starting = 0): string | null {
    const running = Math.max(this.runningCount, this.deps.liveWorkers().length) + starting;
    return limitHold(this.file.settings, running, this.deps.memory())?.why ?? null;
  }

  /** The runs that ended in the last `days` days, newest first. */
  history(days: number): WorkerRun[] {
    // A day over: the page cuts by calendar day, from the start of the oldest one.
    const since = this.now() - (days + 1) * DAY_MS;
    return (this.deps.history?.load() ?? []).filter((r) => r.endedAt >= since).sort((a, b) => b.endedAt - a.endedAt);
  }

  /** Reap and start now. A tick already under way is not doubled: one more follows it. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } catch (err) {
        this.lastError = (err as Error).message;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Stop one of this queue's workers by hand: its window is killed, and the
   * issue is put back with `hold` on it, so no machine takes it again until
   * a person lifts that. The worktree stays, since it may hold work not pushed.
   * Answers null, or why it could not.
   */
  async stop(repo: string, number: number): Promise<string | null> {
    // Under the pass's own lock: a pass must not reap or claim this worker while it is being stopped.
    while (this.running) await this.running;
    let answer: string | null = null;
    this.running = this.stopNow(repo, number)
      .then((a) => void (answer = a))
      .finally(() => {
        this.running = null;
        if (this.again) void this.tick();
      });
    await this.running;
    return answer;
  }

  private async stopNow(repo: string, number: number): Promise<string | null> {
    const w = this.file.workers.find((r) => r.repo === repo && r.number === number);
    if (!w) return "No worker of this machine's queue runs on that issue";
    const windows = await this.windows();
    // Window ids repeat after tmux restarts: kill only the window known to be this worker's.
    if (!windows) return "tmux did not say which windows are open; nothing was stopped";
    if (windows.has(windowKey(w))) {
      const killed = await this.deps.tmux(["kill-window", "-t", w.window]);
      if (!killed.ok) return "tmux could not close the worker's window; nothing was stopped";
    }
    this.file.workers = this.file.workers.filter((r) => r !== w);
    await this.deps.github.addLabel(repo, number, HOLD);
    await this.release(w, `stopped by hand on ${this.deps.machine()}; its worktree .worktree/${number} is left as it was, and ${HOLD} keeps it out of the queue`);
    this.ended(w, "stopped");
    this.save();
    return null;
  }

  private note(repo: string, number: number, what: string): void {
    this.file.log = [{ at: this.now(), repo, number, what }, ...this.file.log].slice(0, LOG_LIMIT);
  }

  private save(): void {
    this.deps.store.save(this.file);
  }

  /** Record a worker's end in the history and forget what its session held. */
  private ended(w: WorkerRecord, result: RunResult): void {
    this.live.delete(issueKey(w));
    this.deps.history?.append({
      repo: w.repo,
      number: w.number,
      title: w.title,
      url: w.url,
      machine: this.deps.machine(),
      queuedAt: w.queuedAt ?? null,
      startedAt: w.startedAt,
      endedAt: this.now(),
      result,
      peakGiB: w.peakGiB ?? null,
      spendUsd: w.spendUsd ?? null,
    });
  }

  /** The windows tmux has open, as `windowKey()`; null when tmux could not say (then nothing counts as vanished). */
  private async windows(): Promise<Set<string> | null> {
    // Only recorded workers are looked up in it.
    if (this.file.workers.length === 0) return null;
    return listWindows(this.deps.tmux);
  }

  /** Read what each live worker session holds: its memory, its spend, and for this queue's, its peak. */
  private async measure(alive: WorkerRecord[], sessions: LiveWorker[]): Promise<void> {
    const owner = (s: LiveWorker) => alive.find((w) => s.issue === w.number && !!s.cwd && s.cwd.startsWith(w.root));
    const pids = sessions.map((s) => s.pid).filter((p): p is number => typeof p === "number" && p > 0);
    const mem = pids.length && this.deps.measure ? await this.deps.measure(pids).catch(() => new Map<number, number>()) : new Map<number, number>();
    const memOf = (s: LiveWorker) => (s.pid ? (mem.get(s.pid) ?? null) : null);
    const others: OtherWorker[] = [];
    for (const s of sessions) {
      const w = owner(s);
      if (!w) {
        others.push({ issue: s.issue, cwd: s.cwd, sessionId: s.id ?? null, memGiB: memOf(s) });
        continue;
      }
      const memGiB = memOf(s);
      const live = this.live.get(issueKey(w));
      this.live.set(issueKey(w), { sessionId: s.id ?? null, memGiB, labels: live?.labels ?? [] });
      if (memGiB !== null) w.peakGiB = Math.max(w.peakGiB ?? 0, memGiB);
      if (s.transcript && this.deps.spend) {
        const spent = await this.deps.spend(s.transcript).catch(() => null);
        if (spent !== null) w.spendUsd = spent;
      }
    }
    this.others = others;
  }

  private async pass(): Promise<void> {
    this.lastTickAt = this.now();
    this.lastError = null;
    const windows = await this.windows();
    await this.reap(windows);

    const alive = this.file.workers.filter((w) => windows?.has(windowKey(w)) ?? true);
    const sessions = this.deps.liveWorkers();
    for (const w of this.file.workers) {
      const live = this.live.get(issueKey(w));
      if (live) live.sessionId = live.memGiB = null;
    }
    await this.measure(alive, sessions);
    let running = alive.length + this.others.length;
    this.runningCount = running;

    const { settings } = this.file;
    const memory = this.deps.memory();
    this.memoryNow = memory;
    let free = memory.availableGiB;

    const holdNow = (): { why: string; kind: WaitKind } | null =>
      settings.enabled ? limitHold(settings, running, { ...memory, availableGiB: free }) : { why: "Off on this machine", kind: "off" };

    const ready = this.deps.ready();
    const seen = this.file.seen ?? {};
    const stillSeen: Record<string, number> = {};
    // An issue waits only while nothing owns it: a worker's, a retried or a held issue starts its wait again when it comes back.
    for (const issue of ready) {
      const key = issueKey(issue);
      if (takenBy(issue.labels) || this.file.workers.some((w) => issueKey(w) === key)) continue;
      stillSeen[key] = seen[key] ?? this.now();
    }
    this.file.seen = stillSeen;

    const waiting: WaitingIssue[] = [];
    const wait = (issue: ReadyIssue, why: string, kind: WaitKind) =>
      waiting.push({ repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, why, kind, since: stillSeen[issueKey(issue)] ?? null });

    const here = placeName(this.deps.machine());
    for (const issue of ready) {
      if (this.file.workers.some((w) => w.repo === issue.repo && w.number === issue.number)) continue;
      const taken = takenBy(issue.labels);
      if (taken) {
        wait(issue, taken.why, taken.kind);
        continue;
      }
      if (issue.blockedBy > 0) {
        wait(issue, issue.blockedBy === 1 ? "Blocked by an open issue" : `Blocked by ${issue.blockedBy} open issues`, "blocked");
        continue;
      }
      const kept = this.deps.keptBy(issue.repo);
      if (kept) {
        wait(issue, `Runs only on ${kept}`, "placed");
        continue;
      }
      const placed = this.deps.placement(issue.repo);
      if (placed && !placed.includes(here)) {
        wait(issue, `Placed on ${placed.join(", ")}`, "placed");
        continue;
      }
      const hold = holdNow();
      if (hold) {
        wait(issue, hold.why, hold.kind);
        continue;
      }
      const outcome = await this.claim(issue, stillSeen[issueKey(issue)] ?? null);
      if (outcome === "started") {
        running++;
        if (free !== null) free -= WORKER_ESTIMATE_GIB;
      } else if (outcome) wait(issue, outcome.why, outcome.kind);
    }
    this.runningCount = running;
    this.hold = holdNow()?.why ?? null;
    this.waiting = waiting;
    this.save();
  }

  /** Take one issue: "started", or why not (null when GitHub already says it is taken). */
  private async claim(issue: ReadyIssue, queuedAt: number | null): Promise<"started" | { why: string; kind: WaitKind } | null> {
    const { github } = this.deps;
    const { repo, number } = issue;
    const now = await github.issue(repo, number);
    if (!now) return { why: "GitHub did not answer", kind: "github" };
    // The sweep's labels may be a minute old; this read is not.
    if (!now.open) return { why: "Closed", kind: "closed" };
    const taken = takenBy(now.labels);
    if (taken) return taken;

    const mine = await github.comment(repo, number, claimBody(this.deps.machineId, this.deps.machine()));
    if (mine === null) return { why: "Could not comment on it", kind: "github" };
    await github.addLabel(repo, number, IN_PROGRESS);
    let winner: Marker | null = null;
    for (let read = 0; read < MARKER_READS && !winner; read++) {
      await this.sleep(CLAIM_SETTLE_MS);
      const markers = await github.markers(repo, number);
      winner = markers ? winningClaim(markers, mine) : null;
    }
    if (!winner || winner.id !== mine) {
      await github.deleteComment(repo, mine);
      if (!winner) {
        // Who won is unknown. Releasing could void another machine's claim and start a
        // second worker, so the label stays, and a person looks.
        this.note(repo, number, `Could not read its claims back: left ${IN_PROGRESS} on it, check that a worker runs`);
        return { why: "Could not read its claims", kind: "github" };
      }
      this.note(repo, number, `Another machine claimed it (${claimant(winner) ?? "unknown"})`);
      return TAKEN_WHY[IN_PROGRESS];
    }

    const started = await this.spawn(issue, now.labels.includes(STOP_AT_PR));
    if (!started) {
      await this.release(issue, "Worker could not start");
      return { why: "The worker could not start", kind: "github" };
    }
    started.queuedAt = queuedAt;
    this.file.workers.push(started);
    this.live.set(issueKey(started), { sessionId: null, memGiB: null, labels: [...now.labels, IN_PROGRESS] });
    this.note(repo, number, `Started in ${started.target}`);
    this.save();
    return "started";
  }

  /** Put an issue back in the queue: a release marker, so the claim before it never wins again, and its label off. */
  private async release(issue: { repo: string; number: number }, why: string): Promise<void> {
    await this.deps.github.comment(issue.repo, issue.number, `${RELEASE_MARK}\nclaude-mux put this issue back in the queue: ${why}.`);
    await this.deps.github.removeLabel(issue.repo, issue.number, IN_PROGRESS);
    this.note(issue.repo, issue.number, `Put back: ${why}`);
  }

  private async spawn(issue: ReadyIssue, stopAtPr: boolean): Promise<WorkerRecord | null> {
    const session = queueSessionName(issue.repo);
    const titleSlug = slug(issue.title);
    const name = titleSlug ? `mw-${issue.number}-${titleSlug}` : `mw-${issue.number}`;
    // A claude-mux started from a Claude session would pass CLAUDECODE on, and claude refuses to start nested.
    const env = `env -u CLAUDECODE MAESTRO_ROLE=worker MAESTRO_ISSUE=${issue.number}${stopAtPr ? " MAESTRO_STOP_AT_PR=1" : ""}`;
    const command = `${env} ${(this.deps.workerCommand ?? defaultWorkerCommand)(issue.number, stopAtPr)}`;
    const line = await openWindow(this.deps.tmux, session, name, issue.root, command);
    if (!line) return null;
    const [server, window] = line.split(" ");
    return {
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      root: issue.root,
      window,
      server,
      name,
      target: `${session}:${name}`,
      startedAt: this.now(),
    };
  }

  private async reap(windows: Set<string> | null): Promise<void> {
    const keep: WorkerRecord[] = [];
    const issues = await Promise.all(this.file.workers.map((w) => this.deps.github.issue(w.repo, w.number)));
    for (const [i, w] of this.file.workers.entries()) {
      const key = issueKey(w);
      const now = issues[i];
      const alive = windows?.has(windowKey(w)) ?? true;
      if (!now) {
        keep.push(w);
        continue;
      }
      const live = this.live.get(key);
      this.live.set(key, { sessionId: live?.sessionId ?? null, memGiB: live?.memGiB ?? null, labels: now.labels });
      if (!now.open) {
        if (alive) await this.deps.tmux(["kill-window", "-t", w.window]);
        await this.deps.git(w.root, ["worktree", "remove", "--force", `.worktree/${w.number}`]);
        await this.deps.git(w.root, ["branch", "-D", `task/${w.number}`]);
        this.file.retried = this.file.retried.filter((k) => k !== key);
        this.note(w.repo, w.number, "Closed: worker ended and its worktree removed");
        this.ended(w, closedResult(now));
        continue;
      }
      if (alive) {
        keep.push(w);
        continue;
      }
      // The window is gone and the issue still open.
      if (now.labels.includes(NEEDS_HELP) || now.labels.includes(READY_FOR_HUMAN)) {
        this.file.retried = this.file.retried.filter((k) => k !== key);
        this.note(w.repo, w.number, "Worker ended; the issue waits on a person");
        this.ended(w, "help");
        continue;
      }
      if (this.file.retried.includes(key)) {
        this.file.retried = this.file.retried.filter((k) => k !== key);
        await this.deps.github.addLabel(w.repo, w.number, NEEDS_HELP);
        await this.deps.github.removeLabel(w.repo, w.number, IN_PROGRESS);
        await this.deps.github.comment(
          w.repo,
          w.number,
          `claude-mux on **${this.deps.machine()}**: needs help. The worker disappeared twice without finishing.`
        );
        this.note(w.repo, w.number, "Worker disappeared twice: asked for help");
        this.ended(w, "lost");
        continue;
      }
      this.file.retried.push(key);
      await this.release(w, "its worker disappeared, trying once more");
      // Not a finished run: the issue goes back and its retry is the run that counts.
      this.live.delete(key);
    }
    if (keep.length !== this.file.workers.length) {
      this.file.workers = keep;
      this.save();
    }
  }
}

// ── the real thing ───────────────────────────────────────────────────────────

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: err ? `${stdout}${stderr}` : stdout })
    );
  });
}

/**
 * tmux, with the first session of a server started in a systemd scope of its
 * own (as `tmuxNewSession()` does), so the panes are not part of the
 * claude-mux service and a restart of it does not take the workers with it.
 */
export const realTmux: TmuxRunner = async (args) => {
  if (args[0] === "new-session" && process.platform === "linux" && !tmuxServerRunning()) {
    const scoped = await run("systemd-run", [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=claude-mux-tmux-${Date.now()}`,
      "--",
      "tmux",
      ...args,
    ]);
    if (scoped.ok) return scoped;
  }
  return run("tmux", args);
};

export const realGit: GitRunner = async (cwd, args) => (await git(args, cwd)) !== null;

const gh = (args: string[]) => run("gh", args);

export const realGithub: QueueGithub = {
  async issue(repo, number) {
    const res = await gh(["api", `repos/${repo}/issues/${number}`, "--jq", "{state, state_reason, labels: [.labels[].name]}"]);
    if (!res.ok) return null;
    try {
      const raw = JSON.parse(res.stdout) as { state: string; state_reason: string | null; labels: string[] };
      return { open: raw.state === "open", labels: raw.labels, reason: raw.state_reason };
    } catch {
      return null;
    }
  },
  async comment(repo, number, body) {
    const res = await gh(["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`, "--jq", ".id"]);
    const id = Number(res.stdout.trim());
    return res.ok && id > 0 ? id : null;
  },
  async deleteComment(repo, id) {
    return (await gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`])).ok;
  },
  async markers(repo, number) {
    const res = await gh([
      "api",
      "--paginate",
      `repos/${repo}/issues/${number}/comments?per_page=100`,
      "--jq",
      '.[] | select((.body // "") | contains("<!-- claude-mux:")) | {id, body, created_at}',
    ]);
    if (!res.ok) return null;
    try {
      return res.stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const raw = JSON.parse(l) as { id: number; body: string; created_at: string };
          return { id: raw.id, body: raw.body, at: Date.parse(raw.created_at) };
        });
    } catch {
      return null;
    }
  },
  async addLabel(repo, number, label) {
    return (await gh(["api", "-X", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${label}`])).ok;
  },
  async removeLabel(repo, number, label) {
    const res = await gh(["api", "-X", "DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`]);
    // A label already off is what was wanted.
    return res.ok || res.stdout.includes("Label does not exist");
  },
};

/** MemAvailable and `full avg60` memory pressure, read from `/proc`; nulls off Linux. */
export function readMemory(): MemoryReading {
  let totalGiB: number | null = null;
  let availableGiB: number | null = null;
  let pressure: number | null = null;
  try {
    const info = readFileSync("/proc/meminfo", "utf-8");
    const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(info);
    if (total) totalGiB = Number(total[1]) / 1024 / 1024;
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(info);
    if (m) availableGiB = Number(m[1]) / 1024 / 1024;
  } catch {
    // Not Linux.
  }
  try {
    const m = /^full .*\bavg60=([\d.]+)/m.exec(readFileSync("/proc/pressure/memory", "utf-8"));
    if (m) pressure = Number(m[1]);
  } catch {
    // No PSI in this kernel.
  }
  return { totalGiB, availableGiB, pressure };
}

/** Resident memory per process tree, by root pid, in GiB, from one process table. */
export function sumTrees(rows: ProcessRow[], roots: readonly number[]): Map<number, number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const out = new Map<number, number>();
  for (const root of roots) {
    const self = byPid.get(root);
    if (!self) continue;
    let kb = 0;
    const stack = [self];
    while (stack.length) {
      const r = stack.pop()!;
      kb += r.rssKb ?? 0;
      stack.push(...(children.get(r.pid) ?? []));
    }
    out.set(root, kb / 1024 / 1024);
  }
  return out;
}

export async function measureTrees(roots: number[]): Promise<Map<number, number>> {
  const rows = await readProcessTable();
  return rows ? sumTrees(rows, roots) : new Map();
}
