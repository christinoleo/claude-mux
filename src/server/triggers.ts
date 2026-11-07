/**
 * Triggers and their Runs (#202, map #177; decided in #184, #166 and #165).
 *
 * A Trigger is when plus what. When is a clock schedule (this file) or an
 * event the GitHub poller finds (the state map, `src/db/event-map-json.ts`,
 * shown here through `eventTriggers()`). What is a rule or a session. Each
 * firing is a Run, run or skipped, with its reason. A Scheduled Task is a
 * clock Trigger that opens a session.
 *
 * Timing is every N seconds, minutes, hours or days, chosen weekdays at a
 * time, or once on a date; no cron. A rule fires at any interval. A Trigger
 * that opens a session never has two at once: a firing due while its last Run
 * still goes is skipped and recorded, and a session starts only when the
 * worker queue's limit and memory brake let it. A clock firing missed while
 * the server was down is skipped and recorded, never made up in bulk.
 *
 * A session Run ends itself the way #165 found works:
 *
 * - The time limit lives in the pane, as `timeout --foreground` around
 *   `claude`, so it holds whether or not this server is up, and ends a Run on
 *   a dialog or mid-tool (exit 124). The exit code is written to a file next
 *   to the triggers, which is how the Run's ending is told afterwards.
 * - Once the hooks say the turn ended and the pane shows the prompt with
 *   nothing in it, `/exit` is typed. Never into a dialog: Enter there would
 *   answer it. A pane that is still open a while after is killed.
 *
 * Kept per machine in `~/.claude-mux/triggers.json`.
 */

import { readFileSync, mkdirSync, rmSync } from "fs";
import { setTimeout as delay } from "timers/promises";
import { join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { shellQuote } from "../utils/shell.js";
import { listWindows, openWindow, slug, type TmuxRunner } from "./worker-queue.js";
import { STOP_AT_PR } from "./github.js";
import { RELEASE_REPO } from "./github-events.js";
import { isDialogState } from "../tmux/pane.js";
import { DAY_NAMES, UNITS, UNIT_MS, type Schedule, type Unit } from "../trigger-schedule.js";

// ── schedules ────────────────────────────────────────────────────────────────

export { UNITS, type Unit, type Schedule } from "../trigger-schedule.js";

function parseTime(time: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? [h, min] : null;
}

/** A schedule as a request sends it, checked; a string says what is wrong. */
export function parseSchedule(raw: unknown): Schedule | string {
  if (!raw || typeof raw !== "object") return "when must be given";
  const r = raw as Record<string, unknown>;
  if (r.type === "every") {
    if (!(UNITS as readonly unknown[]).includes(r.unit)) return `unit must be one of ${UNITS.join(", ")}`;
    if (typeof r.n !== "number" || !Number.isInteger(r.n) || r.n < 1 || r.n > 100_000) return "every must be a whole number from 1";
    return { type: "every", n: r.n, unit: r.unit as Unit };
  }
  if (r.type === "weekly") {
    const days = Array.isArray(r.days) ? r.days : [];
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
      return "choose at least one weekday";
    }
    if (typeof r.time !== "string" || !parseTime(r.time)) return "time must be HH:MM";
    return { type: "weekly", days: [...new Set(days as number[])].sort(), time: r.time };
  }
  if (r.type === "once") {
    if (typeof r.at !== "number" || !Number.isFinite(r.at)) return "a date must be given";
    return { type: "once", at: r.at };
  }
  return "when must be every, weekly or once";
}

/**
 * The first firing after `after`, or null when there is none. `anchor` is
 * where an interval counts from (the Trigger's creation), so it keeps its
 * phase across restarts.
 */
export function nextFiring(schedule: Schedule, after: number, anchor: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "every" && schedule.unit === "day") return nextLocalDay(schedule.n, after, anchor);
  if (schedule.type === "every") {
    const period = schedule.n * UNIT_MS[schedule.unit];
    if (after < anchor) return anchor + period;
    return anchor + (Math.floor((after - anchor) / period) + 1) * period;
  }
  const [h, min] = parseTime(schedule.time) ?? [0, 0];
  const day = new Date(after);
  // Eight days covers a week's worth of candidates and today's, whatever the time.
  for (let i = 0; i <= 8; i++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i, h, min, 0, 0);
    if (at.getTime() > after && schedule.days.includes(at.getDay())) return at.getTime();
  }
  return null;
}

/**
 * Every N days steps the calendar in local time, at the anchor's time of day,
 * so a daily Trigger keeps its hour across a change to or from summer time.
 */
function nextLocalDay(n: number, after: number, anchor: number): number {
  const a = new Date(anchor);
  const firing = (k: number) =>
    new Date(a.getFullYear(), a.getMonth(), a.getDate() + k * n, a.getHours(), a.getMinutes(), a.getSeconds(), a.getMilliseconds()).getTime();
  // An estimate off by at most one either way, since a local day is 23 to 25 hours.
  let k = Math.max(1, Math.floor((after - anchor) / (n * UNIT_MS.day)));
  while (k > 1 && firing(k - 1) > after) k--;
  while (firing(k) <= after) k++;
  return firing(k);
}

/** How much longer than 24 hours a local day can be, across a change from summer time. */
const DST_SLACK_MS = 3_600_000;

/** The longest a schedule can rightly wait between firings; null for a `once`, which waits for its date. */
function longestWait(schedule: Schedule): number | null {
  if (schedule.type === "once") return null;
  if (schedule.type === "every") return schedule.n * UNIT_MS[schedule.unit] + (schedule.unit === "day" ? DST_SLACK_MS : 0);
  return 7 * UNIT_MS.day + DST_SLACK_MS;
}

/** How many firings fell in `[from, to]`, counting `from` itself; capped, since a second's rule could miss days of them. */
export function firingsBetween(schedule: Schedule, from: number, to: number, anchor: number, cap = 100_000): number {
  if (schedule.type === "every" && schedule.unit !== "day") {
    const period = schedule.n * UNIT_MS[schedule.unit];
    return Math.min(cap, Math.floor((to - from) / period) + 1);
  }
  let count = 0;
  for (let at: number | null = from; at !== null && at <= to && count < cap; at = nextFiring(schedule, at, anchor)) count++;
  return count;
}

// ── what is kept ─────────────────────────────────────────────────────────────

const TRIGGER_ACTIONS = ["rule", "session"] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

export interface ClockTrigger {
  id: string;
  name: string;
  when: Schedule;
  what: TriggerAction;
  /** The project's checkout on this machine; a session runs there. Null for a rule. */
  root: string | null;
  /** `owner/name`, for the screen, when the project is on GitHub. */
  repo: string | null;
  /** What the session is told. */
  prompt: string;
  /** The session's hard limit. */
  limitMinutes: number;
  /** A bug the session files stops at its pull request. */
  stopAtPr: boolean;
  paused: boolean;
  createdAt: number;
  /** When it fires next; null once a `once` has fired or a schedule has no firing left. */
  next: number | null;
}

export type RunStatus = "ran" | "skipped" | "running" | "done" | "timed-out" | "ended" | "failed";

export interface Run {
  id: string;
  trigger: string;
  /** When it was due. */
  at: number;
  status: RunStatus;
  /** Why it was skipped, or how it went. */
  reason: string;
  /** A session Run's tmux window, as `list-windows` names it (`#{pid} #{window_id} #{window_name}`). */
  window?: string;
  /** `session:window`, for the screen while it runs. */
  target?: string;
  /** The session's pane as its hooks name it, which its page is opened by. */
  pane?: string;
  /** The Claude Code session, once its hooks report: its live page, then its past one. */
  sessionId?: string;
  endedAt?: number;
  /** When `/exit` was typed. */
  closingAt?: number;
  /** A session Run's limit, kept on the Run so it holds after its Trigger is deleted. */
  limitMinutes?: number;
  /** Why the server killed its window, when it did: no exit code is written then. */
  killed?: "limit" | "close";
  /** When the Enter after `/exit` was sent again, because the box still held it. */
  exitRetriedAt?: number;
  /** How many firings in a row this skip stands for, when more than one; `at` is the latest. */
  count?: number;
}

export interface TriggersFile {
  v: 1;
  triggers: ClockTrigger[];
  /** Newest first. */
  runs: Run[];
}

export interface TriggerStore {
  load(): TriggersFile;
  save(file: TriggersFile): void;
}

export function fileTriggerStore(path: string): TriggerStore {
  return {
    load() {
      let raw: Partial<TriggersFile> = {};
      try {
        raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TriggersFile>;
      } catch {
        // Missing or torn: nothing scheduled.
      }
      return {
        v: 1,
        triggers: Array.isArray(raw.triggers) ? raw.triggers : [],
        runs: Array.isArray(raw.runs) ? raw.runs : [],
      };
    },
    save(file) {
      writeFileAtomic(path, JSON.stringify(file, null, 2));
    },
  };
}

/**
 * How many Runs a Trigger keeps, and how many skips apart from them, so a
 * stretch of skips cannot push the Runs that ran out of the history.
 */
export const RUNS_KEPT = 50;
/** A firing later than this is one the server was not there for. */
export const GRACE_MS = 60_000;
/** How long a pane may stay open after `/exit` before it is killed. */
export const CLOSE_WAIT_MS = 30_000;
/** How far past its limit a pane may stay open before it is killed, should `timeout` itself have failed. */
const LIMIT_SLACK_MS = 60_000;
/** How often running session Runs are looked at. */
export const RUN_CHECK_MS = 5_000;
const DEFAULT_LIMIT_MINUTES = 45;
/** Between the Escape and `/exit`: a key right behind an Escape reads as Alt and that key. */
const ESCAPE_GAP_MS = 150;

// ── the new-trigger form ─────────────────────────────────────────────────────

export interface TriggerInput {
  name: string;
  when: Schedule;
  what: TriggerAction;
  root: string | null;
  repo: string | null;
  prompt: string;
  limitMinutes: number;
  stopAtPr: boolean;
}

/** A Trigger as the form sends it, checked; a string says what is wrong. */
export function parseTriggerInput(raw: unknown, now: number = Date.now()): TriggerInput | string {
  if (!raw || typeof raw !== "object") return "a trigger must be an object";
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name.length > 80) return "a name of up to 80 characters is needed";
  const when = parseSchedule(r.when);
  if (typeof when === "string") return when;
  // It would never fire, and the screen would only say there is nothing left to fire.
  if (when.type === "once" && when.at <= now) return "that date has already passed";
  if (!(TRIGGER_ACTIONS as readonly unknown[]).includes(r.what)) return "what must be rule or session";
  const what = r.what as TriggerAction;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  const root = typeof r.root === "string" && r.root.startsWith("/") ? r.root : null;
  const repo = typeof r.repo === "string" && r.repo ? r.repo : null;
  const limitMinutes = r.limitMinutes === undefined ? DEFAULT_LIMIT_MINUTES : r.limitMinutes;
  if (typeof limitMinutes !== "number" || !Number.isInteger(limitMinutes) || limitMinutes < 1 || limitMinutes > 24 * 60) {
    return "the time limit must be from 1 minute to a day";
  }
  if (what === "session") {
    if (!root) return "a session needs a project";
    if (!prompt) return "a session needs a prompt";
    // Bursts of sessions are what the rule is for; a session fires at most once a minute.
    if (when.type === "every" && when.n * UNIT_MS[when.unit] < 60_000) return "a session fires at most once a minute";
  }
  return { name, when, what, root, repo, prompt, limitMinutes, stopAtPr: r.stopAtPr !== false };
}

/** What a session Run is told: the Trigger's prompt, and what being unattended means. */
export function runPrompt(trigger: Pick<ClockTrigger, "prompt" | "stopAtPr" | "name">): string {
  const lines = [
    trigger.prompt,
    "",
    `This session is a Scheduled Task ("${trigger.name}") running unattended: nobody will answer a question or approve anything. When the job is done, end your turn and the session will be closed.`,
  ];
  if (trigger.stopAtPr) {
    lines.push(
      `If you file a GitHub issue for a bug you find, label it \`${STOP_AT_PR}\`, so the worker that takes it opens a pull request and stops there.`
    );
  }
  return lines.join("\n");
}

function defaultRunCommand(prompt: string): string {
  return `claude --dangerously-skip-permissions ${shellQuote(prompt)}`;
}

// ── the scheduler ────────────────────────────────────────────────────────────

/** A live session as the hooks recorded it, as far as the scheduler cares. */
export interface RunSession {
  id: string;
  /** Its pane, `session:window.pane`, as the hooks recorded it. */
  target: string | null;
  runId: string;
  state: string;
  turnCompletedAt: number | null;
  backgroundTasks: number;
}

export interface SchedulerDeps {
  store: TriggerStore;
  tmux: TmuxRunner;
  /** Where each session Run's exit code is written, `<run id>.exit`. */
  exitDir: string;
  /** The worker queue's word on whether a session may start now: null for yes, else why not. */
  room: (starting: number) => string | null;
  sessions: () => RunSession[];
  /** The pane's screen, with colour; null when it cannot be read. */
  capture: (window: string) => Promise<string | null>;
  /** Whether a screen shows the prompt, empty and ready; `isPaneShowingIdlePrompt()` and an empty box. */
  atPrompt: (screen: string) => boolean;
  /** What a person or a key typed into the screen's prompt box, trimmed; null when it holds nothing typed. */
  typed: (screen: string) => string | null;
  /** The command a session Run runs, given its prompt; `CLAUDE_MUX_RUN_COMMAND` for a test. */
  runCommand?: (prompt: string) => string;
  now?: () => number;
}

function newId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function runSessionName(root: string): string {
  return `runs-${(root.split("/").filter(Boolean).at(-1) ?? "home").replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export class Scheduler {
  private file: TriggersFile;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private lastRunCheck = 0;
  /** The last thing a tick failed at, for the screen. */
  lastError: string | null = null;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.file = deps.store.load();
    // A Run recorded as starting whose window never came: the server stopped in between.
    for (const run of this.file.runs) {
      if (run.status === "running" && !run.window) {
        Object.assign(run, { status: "failed", reason: "The server stopped before the session started", endedAt: this.now() });
      }
    }
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  triggers(): ClockTrigger[] {
    return this.file.triggers;
  }

  runs(trigger: string): Run[] {
    return this.file.runs.filter((r) => r.trigger === trigger);
  }

  create(input: TriggerInput): ClockTrigger {
    const now = this.now();
    const trigger: ClockTrigger = {
      id: newId("t", now),
      ...input,
      paused: false,
      createdAt: now,
      next: nextFiring(input.when, now, now),
    };
    this.file.triggers.push(trigger);
    this.save();
    return trigger;
  }

  /** Pause or resume. A resumed Trigger fires next from now, so the pause leaves no missed firings behind. */
  setPaused(id: string, paused: boolean): ClockTrigger | null {
    const trigger = this.file.triggers.find((t) => t.id === id);
    if (!trigger) return null;
    trigger.paused = paused;
    if (!paused) trigger.next = nextFiring(trigger.when, this.now(), trigger.createdAt);
    this.save();
    return trigger;
  }

  /** Remove a Trigger and its Runs. A session Run still going is left to end itself. */
  remove(id: string): boolean {
    const before = this.file.triggers.length;
    this.file.triggers = this.file.triggers.filter((t) => t.id !== id);
    if (this.file.triggers.length === before) return false;
    this.file.runs = this.file.runs.filter((r) => r.trigger !== id || r.status === "running");
    this.save();
    return true;
  }

  /** Fire what is due, then look at the session Runs still going. One tick at a time. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        let changed = this.fireDue();
        // On disk before any window opens: a restart from here on fails the Run and moves on, never opens it twice.
        if (changed) this.save();
        changed = false;
        const now = this.now();
        const watch = this.file.runs.some((r) => r.status === "running");
        if (watch && now - this.lastRunCheck >= RUN_CHECK_MS) {
          this.lastRunCheck = now;
          try {
            changed = (await this.checkRuns()) || changed;
          } catch (err) {
            // A failed look at tmux must not keep the starts below from happening.
            this.lastError = (err as Error).message;
          }
        }
        // Spawning is async; fireDue only queued the starts.
        await this.startQueued();
        if (changed) this.save();
      } catch (err) {
        // Called as `void tick()` from a timer: nothing above may reach the process as an unhandled rejection.
        this.lastError = (err as Error).message;
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private queued: { trigger: ClockTrigger; run: Run }[] = [];

  private fireDue(): boolean {
    const now = this.now();
    let changed = false;
    for (const trigger of this.file.triggers) {
      if (trigger.next === null) continue;
      if (trigger.paused) {
        // A paused `once` whose date passes would otherwise leave nothing to say it never ran.
        if (trigger.when.type === "once" && trigger.next <= now) {
          this.record(trigger, trigger.next, "skipped", "Paused at its date");
          trigger.next = null;
          changed = true;
        }
        continue;
      }
      changed = this.realign(trigger, now) || changed;
      if (trigger.next === null || trigger.next > now) continue;
      const due = trigger.next;
      const passed = firingsBetween(trigger.when, due, now, trigger.createdAt);
      if (now - due > GRACE_MS) {
        this.record(trigger, due, "skipped", "Missed while the server was down", passed);
      } else {
        if (trigger.what === "rule") this.record(trigger, due, "ran", "Recorded");
        else this.fireSession(trigger, due);
        // A tick that ran long, or came late, passes firings it cannot make up.
        if (passed > 1) this.record(trigger, now, "skipped", "Missed while a tick ran late", passed - 1);
      }
      trigger.next = nextFiring(trigger.when, now, trigger.createdAt);
      changed = true;
    }
    return changed;
  }

  /**
   * A clock that ran ahead and came back leaves a creation date in the future,
   * or a next firing further off than the schedule ever waits, and the Trigger
   * would sit silent for as long as the clock was ahead. Either is counted
   * again from now.
   */
  private realign(trigger: ClockTrigger, now: number): boolean {
    let changed = false;
    if (trigger.createdAt > now) {
      trigger.createdAt = now;
      changed = true;
    }
    const longest = longestWait(trigger.when);
    if (changed || (longest !== null && trigger.next !== null && trigger.next - now > longest)) {
      trigger.next = nextFiring(trigger.when, now, trigger.createdAt);
      changed = true;
    }
    return changed;
  }

  private fireSession(trigger: ClockTrigger, due: number): void {
    const going = this.file.runs.find((r) => r.trigger === trigger.id && r.status === "running");
    if (going) {
      this.record(trigger, due, "skipped", "The last Run was still going");
      return;
    }
    const sessions = this.deps.sessions();
    // Started, or about to be, with no hook reported yet: the queue cannot see these.
    const starting = this.file.runs.filter((r) => r.status === "running" && !sessions.some((s) => s.runId === r.id)).length;
    const hold = this.deps.room(starting);
    if (hold) {
      this.record(trigger, due, "skipped", hold);
      return;
    }
    const run = this.record(trigger, due, "running", "Starting");
    run.limitMinutes = trigger.limitMinutes;
    this.queued.push({ trigger, run });
  }

  private async startQueued(): Promise<void> {
    if (this.queued.length === 0) return;
    const queued = this.queued;
    this.queued = [];
    for (const { trigger, run } of queued) {
      // A pause or a delete may have landed while an earlier start in this loop was awaited.
      const now = this.file.triggers.find((t) => t.id === trigger.id);
      if (!now || now.paused) {
        Object.assign(run, { status: "skipped", reason: now ? "Paused before it started" : "Deleted before it started", endedAt: this.now() });
        if (!now) this.file.runs = this.file.runs.filter((r) => r !== run);
      } else {
        const started = await this.spawn(trigger, run);
        if (started) {
          Object.assign(run, started, { reason: "Running" });
        } else {
          Object.assign(run, { status: "failed", reason: "The session could not start", endedAt: this.now() });
        }
      }
      // Each window on disk as soon as it is known, before the next start is awaited.
      this.save();
    }
  }

  private exitFile(run: Pick<Run, "id">): string {
    return join(this.deps.exitDir, `${run.id}.exit`);
  }

  private async spawn(trigger: ClockTrigger, run: Run): Promise<Pick<Run, "window" | "target"> | null> {
    if (!trigger.root) return null;
    try {
      mkdirSync(this.deps.exitDir, { recursive: true });
    } catch {
      return null;
    }
    const session = runSessionName(trigger.root);
    const name = `run-${slug(trigger.name, 24) || "task"}`;
    const command = (this.deps.runCommand ?? defaultRunCommand)(runPrompt(trigger));
    const seconds = trigger.limitMinutes * 60;
    // `--foreground`: plain `timeout` takes claude out of the terminal's foreground group and it never draws (#165).
    // CLAUDE_MUX_RUN_SH names this shell, so the hook takes the Run id only for the claude it started, not for anything that claude starts in turn.
    const inner = `CLAUDE_MUX_RUN_SH=$$ timeout --foreground -k 10 ${seconds} ${command}; echo $? > ${shellQuote(this.exitFile(run))}`;
    // A claude-mux started from a Claude session would pass CLAUDECODE on, and claude refuses to start nested.
    const full = `env -u CLAUDECODE CLAUDE_MUX_RUN=${run.id} sh -c ${shellQuote(inner)}`;
    const window = await openWindow(this.deps.tmux, session, name, trigger.root, full);
    return window ? { window, target: `${session}:${name}` } : null;
  }

  private exitCode(run: Run): number | null {
    try {
      const code = Number.parseInt(readFileSync(this.exitFile(run), "utf-8").trim(), 10);
      return Number.isFinite(code) ? code : null;
    } catch {
      return null;
    }
  }

  /** How a Run whose window is gone ended, told by the exit code its pane wrote. */
  private finish(run: Run): void {
    const code = this.exitCode(run);
    const limitMinutes = run.limitMinutes ?? null;
    run.endedAt = this.now();
    if (code === null && run.killed === "close") {
      run.status = "ended";
      run.reason = "Finished, but the session did not close after /exit and was killed";
    } else if (code === 124 || code === 137 || (code === null && run.killed === "limit")) {
      run.status = "timed-out";
      run.reason = limitMinutes ? `Stopped at its ${limitMinutes}-minute limit` : "Stopped at its time limit";
    } else if (code === 0 || code === null) {
      run.status = code === 0 ? "done" : "ended";
      run.reason = run.closingAt
        ? "Finished, and the session was closed"
        : code === 0
          ? "The session exited"
          : "The session's pane was closed";
    } else {
      run.status = "failed";
      run.reason = `The session exited with code ${code}`;
    }
    rmSync(this.exitFile(run), { force: true });
  }

  /** Whether anything about a Run changed, and so needs saving. */
  private async checkRuns(): Promise<boolean> {
    const windows = await listWindows(this.deps.tmux);
    const sessions = this.deps.sessions();
    const now = this.now();
    let changed = false;
    const orphans = new Set<string>();
    const closing: { run: Run; windowId: string }[] = [];
    for (const run of this.file.runs) {
      if (run.status !== "running" || !run.window) continue;
      const trigger = this.file.triggers.find((t) => t.id === run.trigger) ?? null;
      const session = sessions.find((s) => s.runId === run.id);
      if (session) {
        const pane = session.target ?? run.pane;
        if (run.sessionId !== session.id || run.pane !== pane) changed = true;
        run.sessionId = session.id;
        run.pane = pane;
      }
      if (!windows) continue;
      if (!windows.has(run.window)) {
        this.finish(run);
        // A Run whose Trigger was deleted while it went has nowhere to be shown.
        if (!trigger) orphans.add(run.id);
        changed = true;
        continue;
      }
      const windowId = run.window.split(" ")[1];
      const limit = (run.limitMinutes ?? trigger?.limitMinutes ?? DEFAULT_LIMIT_MINUTES) * 60_000;
      const kill: Run["killed"] =
        run.closingAt && now - run.closingAt > CLOSE_WAIT_MS ? "close" : now - run.at > limit + LIMIT_SLACK_MS ? "limit" : undefined;
      if (kill) {
        await this.deps.tmux(["kill-window", "-t", windowId]);
        if (run.killed !== kill) changed = true;
        run.killed = kill;
        continue;
      }
      if (run.closingAt) {
        await this.confirmExit(run, run.closingAt, windowId, session, now);
        continue;
      }
      if (!session) continue;
      const finished =
        session.state === "idle" &&
        session.backgroundTasks === 0 &&
        session.turnCompletedAt !== null &&
        session.turnCompletedAt >= run.at;
      if (!finished) continue;
      const screen = await this.deps.capture(windowId);
      // Typed into a dialog, `/exit` and Enter would answer it, and typed behind a draft it would join it; only an empty prompt takes it.
      if (!screen || !this.deps.atPrompt(screen)) continue;
      // Escape first, as #165 found safe: it closes whatever drew itself since the screen was read.
      await this.deps.tmux(["send-keys", "-t", windowId, "Escape"]);
      closing.push({ run, windowId });
    }
    if (closing.length > 0) {
      // One wait for every pane closing in this look, so a tick is held up once.
      await delay(ESCAPE_GAP_MS);
      for (const { run, windowId } of closing) {
        await this.deps.tmux(["send-keys", "-t", windowId, "-l", "/exit"]);
        await this.deps.tmux(["send-keys", "-t", windowId, "Enter"]);
        run.closingAt = now;
        run.reason = "Finished: closing the session";
      }
      changed = true;
    }
    if (orphans.size > 0) this.file.runs = this.file.runs.filter((r) => !orphans.has(r.id));
    return changed;
  }

  /**
   * Whether `/exit` was taken. Claude Code can fold an Enter into the text
   * typed just before it, leaving `/exit` in the box, so the box is read back
   * as the send route does, and one more Enter sent when it still holds it.
   */
  private async confirmExit(run: Run, closingAt: number, windowId: string, session: RunSession | undefined, now: number): Promise<void> {
    if (run.exitRetriedAt || now - closingAt < RUN_CHECK_MS) return;
    // A dialog that opened meanwhile would take the Enter as its answer.
    if (isDialogState(session?.state)) return;
    const screen = await this.deps.capture(windowId);
    if (!screen || this.deps.typed(screen) !== "/exit") return;
    await this.deps.tmux(["send-keys", "-t", windowId, "Enter"]);
    run.exitRetriedAt = now;
  }

  /** Record a Run; a skip stands for `firings` firings. */
  private record(trigger: ClockTrigger, at: number, status: RunStatus, reason: string, firings = 1): Run {
    // A skip for the same reason as the last one, with only Runs that ran between them, is that entry counted again.
    const latest = this.file.runs.find((r) => r.trigger === trigger.id && r.status !== "ran");
    if (status === "skipped" && latest?.status === "skipped" && latest.reason === reason) {
      Object.assign(latest, { at, count: (latest.count ?? 1) + firings, endedAt: this.now() });
      return latest;
    }
    const run: Run = { id: newId("r", this.now()), trigger: trigger.id, at, status, reason };
    if (firings > 1) run.count = firings;
    if (status !== "running") run.endedAt = this.now();
    this.file.runs.unshift(run);
    // Each Trigger keeps its own latest Runs and, apart from them, its latest skips; none still going is dropped.
    const counts = new Map<string, number>();
    this.file.runs = this.file.runs.filter((r) => {
      const key = `${r.trigger} ${r.status === "skipped"}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= RUNS_KEPT || r.status === "running";
    });
    return run;
  }

  private save(): void {
    this.deps.store.save(this.file);
  }
}

// ── event Triggers ───────────────────────────────────────────────────────────

/** A Trigger as the screen lists it: a clock one from the file, or an event one from the state map. */
export interface TriggerView {
  id: string;
  kind: "clock" | "event";
  name: string;
  /** How its timing reads, for an event the event. */
  when: string;
  what: TriggerAction;
  repo: string | null;
  root: string | null;
  paused: boolean;
  next: number | null;
  runs: RunView[];
  prompt?: string;
  /** A `once` Trigger's date. */
  onceAt?: number;
}

export interface RunView {
  at: number;
  status: RunStatus;
  reason: string;
  /** How many firings in a row a skip stands for, when more than one. */
  count?: number;
  /** Where to look: the session while it runs or after, an issue or a commit. */
  link: { kind: "session" | "past" | "github"; href: string; label: string } | null;
}

function describeSchedule(s: Schedule): string {
  if (s.type === "every") return s.n === 1 ? `Every ${s.unit}` : `Every ${s.n} ${s.unit}s`;
  if (s.type === "weekly") {
    const days = s.days.length === 7 ? "Every day" : s.days.join(",") === "1,2,3,4,5" ? "Weekdays" : s.days.map((d) => DAY_NAMES[d]).join(", ");
    return `${days} at ${s.time}`;
  }
  // The date itself is drawn by the page, in the reader's own time zone, from the view's `onceAt`.
  return "Once";
}

/** Where a Run can be looked at: its session's page while it runs, its transcript after. */
function runLink(r: Run): RunView["link"] {
  if (!r.sessionId) return null;
  if (r.status === "running" && r.pane) return { kind: "session", href: r.pane, label: r.target ?? r.pane };
  return { kind: "past", href: r.sessionId, label: "Transcript" };
}

export function clockTriggerView(trigger: ClockTrigger, runs: readonly Run[]): TriggerView {
  return {
    id: trigger.id,
    kind: "clock",
    name: trigger.name,
    when: describeSchedule(trigger.when),
    what: trigger.what,
    repo: trigger.repo,
    root: trigger.root,
    paused: trigger.paused,
    next: trigger.paused ? null : trigger.next,
    onceAt: trigger.when.type === "once" ? trigger.when.at : undefined,
    prompt: trigger.prompt,
    runs: runs.map((r) => ({
      at: r.at,
      status: r.status,
      reason: r.reason,
      count: r.count,
      link: runLink(r),
    })),
  };
}

/** What the state map, the poller's log and the worker queue's log say, as the screen reads them. */
export interface EventSources {
  projects: readonly { repo: string; root: string; enabled: boolean; events: Record<string, "ignore" | "rule" | "session"> }[];
  seen: readonly { at: number; repo: string; kind: string; action: string; outcome: string; title: string; url: string }[];
  queue: readonly { at: number; repo: string; number: number; what: string }[];
  /** What the release rule did (`src/server/release.ts`), shown as Runs of claude-mux's push. */
  release?: readonly { at: number; status: RunStatus; reason: string; url?: string }[];
}

const EVENT_NAMES: Record<string, string> = { "issue-ready": "Issue marked ready", push: "Push to the default branch" };

/** What the queue's note says a Run of an issue's event did. */
function queueStatus(what: string): RunStatus {
  // Each note is a moment: a start is shown as having run, and its ending as a note of its own.
  if (what.startsWith("Started")) return "ran";
  if (what.startsWith("Closed")) return "done";
  if (what.startsWith("Worker ended")) return "ended";
  if (/could not|disappeared|asked for help/i.test(what)) return "failed";
  return "skipped";
}

/**
 * The event Triggers: one per enabled project and event that is not ignored,
 * with its Runs from what the poller recorded and, for one that starts a
 * session, what the worker queue did with each issue.
 */
export function eventTriggers(sources: EventSources): TriggerView[] {
  const views: TriggerView[] = [];
  for (const project of sources.projects) {
    if (!project.enabled) continue;
    for (const [kind, action] of Object.entries(project.events)) {
      if (action === "ignore") continue;
      const runs: RunView[] = sources.seen
        .filter((e) => e.repo === project.repo && e.kind === kind)
        .map((e) => ({
          at: e.at,
          status: "ran" as const,
          reason: e.outcome,
          link: { kind: "github" as const, href: e.url, label: e.title },
        }));
      if (kind === "issue-ready" && action === "session") {
        for (const q of sources.queue) {
          if (q.repo !== project.repo) continue;
          runs.push({
            at: q.at,
            status: queueStatus(q.what),
            reason: q.what,
            link: { kind: "github", href: `https://github.com/${q.repo}/issues/${q.number}`, label: `#${q.number}` },
          });
        }
      }
      if (kind === "push" && action === "rule" && project.repo === RELEASE_REPO) {
        for (const r of sources.release ?? []) {
          runs.push({ at: r.at, status: r.status, reason: r.reason, link: r.url ? { kind: "github", href: r.url, label: "GitHub" } : null });
        }
      }
      runs.sort((a, b) => b.at - a.at);
      views.push({
        id: `event:${project.repo}:${kind}`,
        kind: "event",
        name: `${EVENT_NAMES[kind] ?? kind} on ${project.repo}`,
        when: EVENT_NAMES[kind] ?? kind,
        what: action,
        repo: project.repo,
        root: project.root,
        paused: false,
        // An event fires when the next read of GitHub finds it.
        next: null,
        runs: runs.slice(0, RUNS_KEPT),
      });
    }
  }
  return views;
}
