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
import { join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { shellQuote } from "../utils/shell.js";
import type { TmuxRunner } from "./worker-queue.js";
import { STOP_AT_PR } from "./github.js";

// ── schedules ────────────────────────────────────────────────────────────────

export const UNITS = ["second", "minute", "hour", "day"] as const;
export type Unit = (typeof UNITS)[number];
const UNIT_MS: Record<Unit, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export type Schedule =
  | { type: "every"; n: number; unit: Unit }
  /** Days as `Date.getDay()` numbers, Sunday 0; the time is this machine's local time. */
  | { type: "weekly"; days: number[]; time: string }
  | { type: "once"; at: number };

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

/** How many firings fell in `[from, to]`, counting `from` itself; capped, since a second's rule could miss days of them. */
export function firingsBetween(schedule: Schedule, from: number, to: number, anchor: number, cap = 100_000): number {
  if (schedule.type === "every") {
    const period = schedule.n * UNIT_MS[schedule.unit];
    return Math.min(cap, Math.floor((to - from) / period) + 1);
  }
  let count = 0;
  for (let at: number | null = from; at !== null && at <= to && count < cap; at = nextFiring(schedule, at, anchor)) count++;
  return count;
}

// ── what is kept ─────────────────────────────────────────────────────────────

export const TRIGGER_ACTIONS = ["rule", "session"] as const;
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

/** How many Runs a Trigger keeps; a rule every second would otherwise fill the file. */
export const RUNS_KEPT = 50;
/** A firing later than this is one the server was not there for. */
export const GRACE_MS = 60_000;
/** How long a pane may stay open after `/exit` before it is killed. */
export const CLOSE_WAIT_MS = 30_000;
/** How far past its limit a pane may stay open before it is killed, should `timeout` itself have failed. */
export const LIMIT_SLACK_MS = 60_000;
/** How often running session Runs are looked at. */
export const RUN_CHECK_MS = 5_000;
export const DEFAULT_LIMIT_MINUTES = 45;

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
export function parseTriggerInput(raw: unknown): TriggerInput | string {
  if (!raw || typeof raw !== "object") return "a trigger must be an object";
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name.length > 80) return "a name of up to 80 characters is needed";
  const when = parseSchedule(r.when);
  if (typeof when === "string") return when;
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

export function defaultRunCommand(prompt: string): string {
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
  /** The command a session Run runs, given its prompt; `CLAUDE_MUX_RUN_COMMAND` for a test. */
  runCommand?: (prompt: string) => string;
  /** Told after anything a screen shows changed. */
  onChange?: () => void;
  now?: () => number;
}

const WINDOW_FORMAT = "#{pid} #{window_id} #{window_name}";

function newId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).replace(/-$/, "") || "task";
}

export function runSessionName(root: string): string {
  return `runs-${(root.split("/").filter(Boolean).at(-1) ?? "home").replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export class Scheduler {
  private file: TriggersFile;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private lastRunCheck = 0;

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
      root: input.what === "session" ? input.root : input.root ?? null,
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
        const changed = this.fireDue();
        const now = this.now();
        const watch = this.file.runs.some((r) => r.status === "running");
        if (watch && now - this.lastRunCheck >= RUN_CHECK_MS) {
          this.lastRunCheck = now;
          await this.checkRuns();
        } else if (changed) this.save();
        // Spawning is async; fireDue only queued the starts.
        await this.startQueued();
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
      if (trigger.paused || trigger.next === null || trigger.next > now) continue;
      const due = trigger.next;
      if (now - due > GRACE_MS) {
        const missed = firingsBetween(trigger.when, due, now, trigger.createdAt);
        this.record(trigger, due, "skipped", `Missed ${plural(missed, "firing")} while the server was down`);
      } else if (trigger.what === "rule") {
        this.record(trigger, due, "ran", "Recorded");
      } else {
        this.fireSession(trigger, due);
      }
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
    const starting =
      this.file.runs.filter((r) => r.status === "running" && !sessions.some((s) => s.runId === r.id)).length +
      this.queued.length;
    const hold = this.deps.room(starting);
    if (hold) {
      this.record(trigger, due, "skipped", hold);
      return;
    }
    const run = this.record(trigger, due, "running", "Starting");
    this.queued.push({ trigger, run });
  }

  private async startQueued(): Promise<void> {
    if (this.queued.length === 0) return;
    const queued = this.queued;
    this.queued = [];
    for (const { trigger, run } of queued) {
      const started = await this.spawn(trigger, run);
      if (started) {
        Object.assign(run, started, { reason: "Running" });
      } else {
        Object.assign(run, { status: "failed", reason: "The session could not start", endedAt: this.now() });
      }
    }
    this.save();
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
    const name = `run-${slug(trigger.name)}`;
    const command = (this.deps.runCommand ?? defaultRunCommand)(runPrompt(trigger));
    const seconds = trigger.limitMinutes * 60;
    // `--foreground`: plain `timeout` takes claude out of the terminal's foreground group and it never draws (#165).
    const inner = `timeout --foreground -k 10 ${seconds} ${command}; echo $? > ${shellQuote(this.exitFile(run))}`;
    // A claude-mux started from a Claude session would pass CLAUDECODE on, and claude refuses to start nested.
    const full = `env -u CLAUDECODE CLAUDE_MUX_RUN=${run.id} sh -c ${shellQuote(inner)}`;
    const has = await this.deps.tmux(["has-session", "-t", `=${session}`]);
    const args = has.ok
      ? ["new-window", "-d", "-P", "-F", WINDOW_FORMAT, "-t", `=${session}:`, "-n", name, "-c", trigger.root, full]
      : ["new-session", "-d", "-P", "-F", WINDOW_FORMAT, "-s", session, "-n", name, "-c", trigger.root, full];
    const res = await this.deps.tmux(args);
    const window = res.stdout.trim().split("\n")[0];
    if (!res.ok || !window.split(" ")[1]?.startsWith("@")) return null;
    return { window, target: `${session}:${name}` };
  }

  /** The windows tmux has open; null when tmux could not say, and then nothing counts as ended. */
  private async windows(): Promise<Set<string> | null> {
    const res = await this.deps.tmux(["list-windows", "-a", "-F", WINDOW_FORMAT]);
    if (!res.ok) {
      return /no server running|No such file or directory|Connection refused/.test(res.stdout) ? new Set() : null;
    }
    return new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
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
  private finish(run: Run, limitMinutes: number | null): void {
    const code = this.exitCode(run);
    run.endedAt = this.now();
    if (code === 124 || code === 137) {
      run.status = "timed-out";
      run.reason = limitMinutes ? `Stopped at its ${limitMinutes}-minute limit` : "Stopped at its time limit";
    } else if (code === 0) {
      run.status = "done";
      run.reason = run.closingAt ? "Finished, and the session was closed" : "The session exited";
    } else if (code === null) {
      run.status = "ended";
      run.reason = run.closingAt ? "Finished, and the session was closed" : "The session's pane was closed";
    } else {
      run.status = "failed";
      run.reason = `The session exited with code ${code}`;
    }
    rmSync(this.exitFile(run), { force: true });
  }

  private async checkRuns(): Promise<void> {
    const windows = await this.windows();
    const sessions = this.deps.sessions();
    const now = this.now();
    for (const run of this.file.runs) {
      if (run.status !== "running" || !run.window) continue;
      const trigger = this.file.triggers.find((t) => t.id === run.trigger) ?? null;
      const session = sessions.find((s) => s.runId === run.id);
      if (session) {
        run.sessionId = session.id;
        run.pane = session.target ?? run.pane;
      }
      if (windows && !windows.has(run.window)) {
        this.finish(run, trigger?.limitMinutes ?? null);
        continue;
      }
      if (!windows) continue;
      const windowId = run.window.split(" ")[1];
      const limit = (trigger?.limitMinutes ?? DEFAULT_LIMIT_MINUTES) * 60_000;
      if (
        (run.closingAt && now - run.closingAt > CLOSE_WAIT_MS) ||
        now - run.at > limit + LIMIT_SLACK_MS
      ) {
        await this.deps.tmux(["kill-window", "-t", windowId]);
        continue;
      }
      if (run.closingAt || !session) continue;
      const finished =
        session.state === "idle" &&
        session.backgroundTasks === 0 &&
        session.turnCompletedAt !== null &&
        session.turnCompletedAt >= run.at;
      if (!finished) continue;
      const screen = await this.deps.capture(windowId);
      // Typed into a dialog, `/exit` and Enter would answer it; only an empty prompt takes it.
      if (!screen || !this.deps.atPrompt(screen)) continue;
      await this.deps.tmux(["send-keys", "-t", windowId, "-l", "/exit"]);
      await this.deps.tmux(["send-keys", "-t", windowId, "Enter"]);
      run.closingAt = now;
      run.reason = "Finished: closing the session";
    }
    this.save();
  }

  private record(trigger: ClockTrigger, at: number, status: RunStatus, reason: string): Run {
    const run: Run = { id: newId("r", this.now()), trigger: trigger.id, at, status, reason };
    if (status !== "running") run.endedAt = this.now();
    this.file.runs.unshift(run);
    // Each Trigger keeps its own latest Runs, and none still going is dropped.
    const counts = new Map<string, number>();
    this.file.runs = this.file.runs.filter((r) => {
      const n = (counts.get(r.trigger) ?? 0) + 1;
      counts.set(r.trigger, n);
      return n <= RUNS_KEPT || r.status === "running";
    });
    return run;
  }

  private save(): void {
    this.deps.store.save(this.file);
    this.deps.onChange?.();
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
  /** Only a clock Trigger is edited here; an event one is set on the Events screen. */
  editable: boolean;
  prompt?: string;
  limitMinutes?: number;
  stopAtPr?: boolean;
}

export interface RunView {
  at: number;
  status: RunStatus;
  reason: string;
  /** Where to look: the session while it runs or after, an issue or a commit. */
  link: { kind: "session" | "past" | "github"; href: string; label: string } | null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(s: Schedule): string {
  if (s.type === "every") return s.n === 1 ? `Every ${s.unit}` : `Every ${s.n} ${s.unit}s`;
  if (s.type === "weekly") {
    const days = s.days.length === 7 ? "Every day" : s.days.join(",") === "1,2,3,4,5" ? "Weekdays" : s.days.map((d) => DAY_NAMES[d]).join(", ");
    return `${days} at ${s.time}`;
  }
  return `Once, ${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
    editable: true,
    prompt: trigger.prompt,
    limitMinutes: trigger.limitMinutes,
    stopAtPr: trigger.stopAtPr,
    runs: runs.map((r) => ({
      at: r.at,
      status: r.status,
      reason: r.reason,
      link: runLink(r),
    })),
  };
}

/** What the state map, the poller's log and the worker queue's log say, as the screen reads them. */
export interface EventSources {
  projects: readonly { repo: string; root: string; enabled: boolean; events: Record<string, "ignore" | "rule" | "session"> }[];
  seen: readonly { at: number; repo: string; kind: string; action: string; outcome: string; title: string; url: string }[];
  queue: readonly { at: number; repo: string; number: number; what: string }[];
}

const EVENT_NAMES: Record<string, string> = { "issue-ready": "Issue marked ready", push: "Push to the default branch" };

/** What the queue's note says a Run of an issue's event did. */
function queueStatus(what: string): RunStatus {
  if (what.startsWith("Started")) return "running";
  if (what.startsWith("Closed")) return "done";
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
        editable: false,
        runs: runs.slice(0, RUNS_KEPT),
      });
    }
  }
  return views;
}
