import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  Scheduler,
  GRACE_MS,
  CLOSE_WAIT_MS,
  RUN_CHECK_MS,
  RUNS_KEPT,
  eventTriggers,
  firingsBetween,
  nextFiring,
  parseSchedule,
  parseTriggerInput,
  runPrompt,
  type RunSession,
  type TriggerInput,
  type TriggerStore,
  type TriggersFile,
} from "../../src/server/triggers.js";
import type { TmuxRunner } from "../../src/server/worker-queue.js";

const T0 = new Date(2026, 10, 9, 9, 0, 0).getTime(); // Monday 9 Nov 2026, 09:00 local

function memoryStore(): TriggerStore & { file: TriggersFile | null } {
  return {
    file: null,
    load() {
      return this.file ? (JSON.parse(JSON.stringify(this.file)) as TriggersFile) : { v: 1, triggers: [], runs: [] };
    },
    save(file) {
      this.file = JSON.parse(JSON.stringify(file)) as TriggersFile;
    },
  };
}

/** A tmux holding windows, as `list-windows -a` would print them. */
class FakeTmux {
  windows = new Map<string, string>(); // key → command
  sent: string[][] = [];
  killed: string[] = [];
  private next = 1;
  runner: TmuxRunner = async (args) => {
    const [cmd] = args;
    if (cmd === "has-session") return { ok: [...this.windows.keys()].length > 0, stdout: "" };
    if (cmd === "new-window" || cmd === "new-session") {
      const name = args[args.indexOf("-n") + 1];
      const key = `999 @${this.next++} ${name}`;
      this.windows.set(key, args.at(-1)!);
      return { ok: true, stdout: `${key}\n` };
    }
    if (cmd === "list-windows") return { ok: true, stdout: [...this.windows.keys()].join("\n") };
    if (cmd === "send-keys") {
      this.sent.push(args);
      return { ok: true, stdout: "" };
    }
    if (cmd === "kill-window") {
      const id = args[args.indexOf("-t") + 1];
      this.killed.push(id);
      for (const k of this.windows.keys()) if (k.split(" ")[1] === id) this.windows.delete(k);
      return { ok: true, stdout: "" };
    }
    return { ok: false, stdout: "unknown" };
  };
  close(id: string) {
    for (const k of this.windows.keys()) if (k.split(" ")[1] === id) this.windows.delete(k);
  }
}

function session(input: Partial<TriggerInput> = {}): TriggerInput {
  return {
    name: "Nightly check",
    when: { type: "every", n: 1, unit: "hour" },
    what: "session",
    root: "/home/u/Projects/scratch",
    repo: "u/scratch",
    prompt: "Look for broken links",
    limitMinutes: 45,
    stopAtPr: true,
    ...input,
  };
}

function rule(input: Partial<TriggerInput> = {}): TriggerInput {
  return session({ name: "Tick", what: "rule", root: null, prompt: "", when: { type: "every", n: 1, unit: "second" }, ...input });
}

describe("schedules", () => {
  it("every N units counts from its anchor", () => {
    const every5m = { type: "every" as const, n: 5, unit: "minute" as const };
    expect(nextFiring(every5m, T0, T0)).toBe(T0 + 5 * 60_000);
    expect(nextFiring(every5m, T0 + 7 * 60_000, T0)).toBe(T0 + 10 * 60_000);
    expect(nextFiring({ type: "every", n: 1, unit: "second" }, T0 + 1_000, T0)).toBe(T0 + 2_000);
    expect(nextFiring({ type: "every", n: 2, unit: "day" }, T0, T0)).toBe(T0 + 2 * 86_400_000);
    expect(nextFiring({ type: "every", n: 3, unit: "hour" }, T0, T0)).toBe(T0 + 3 * 3_600_000);
  });

  it("weekdays at a time picks the next chosen day", () => {
    const weekdays = { type: "weekly" as const, days: [1, 2, 3, 4, 5], time: "08:30" };
    // Monday 09:00 is past 08:30, so Tuesday.
    expect(new Date(nextFiring(weekdays, T0, T0)!)).toEqual(new Date(2026, 10, 10, 8, 30));
    // Friday 10:00 → Monday.
    expect(new Date(nextFiring(weekdays, new Date(2026, 10, 13, 10).getTime(), T0)!)).toEqual(new Date(2026, 10, 16, 8, 30));
    // Monday 08:00 → the same morning.
    expect(new Date(nextFiring(weekdays, new Date(2026, 10, 9, 8).getTime(), T0)!)).toEqual(new Date(2026, 10, 9, 8, 30));
    expect(new Date(nextFiring({ type: "weekly", days: [0], time: "23:59" }, T0, T0)!)).toEqual(new Date(2026, 10, 15, 23, 59));
  });

  it("once fires on its date and then never", () => {
    const once = { type: "once" as const, at: T0 + 3_600_000 };
    expect(nextFiring(once, T0, T0)).toBe(T0 + 3_600_000);
    expect(nextFiring(once, T0 + 3_600_000, T0)).toBeNull();
  });

  it("counts the firings in a stretch", () => {
    expect(firingsBetween({ type: "every", n: 1, unit: "minute" }, T0, T0 + 10 * 60_000, T0)).toBe(11);
    expect(firingsBetween({ type: "weekly", days: [1, 3], time: "09:00" }, T0, T0 + 7 * 86_400_000, T0)).toBe(3);
  });

  it("refuses what is not a schedule", () => {
    expect(parseSchedule({ type: "cron", expr: "* * * * *" })).toMatch(/every, weekly or once/);
    expect(parseSchedule({ type: "every", n: 0, unit: "minute" })).toMatch(/whole number/);
    expect(parseSchedule({ type: "every", n: 2, unit: "week" })).toMatch(/unit/);
    expect(parseSchedule({ type: "weekly", days: [], time: "08:00" })).toMatch(/weekday/);
    expect(parseSchedule({ type: "weekly", days: [1], time: "25:00" })).toMatch(/HH:MM/);
    expect(parseSchedule({ type: "weekly", days: [3, 1, 1], time: "8:05" })).toEqual({ type: "weekly", days: [1, 3], time: "8:05" });
  });

  it("checks the form: a session needs a project and a prompt, and fires at most once a minute", () => {
    expect(parseTriggerInput({ ...session(), root: null })).toMatch(/project/);
    expect(parseTriggerInput({ ...session(), prompt: " " })).toMatch(/prompt/);
    expect(parseTriggerInput({ ...session(), when: { type: "every", n: 30, unit: "second" } })).toMatch(/once a minute/);
    expect(parseTriggerInput(rule())).toMatchObject({ what: "rule", when: { n: 1, unit: "second" } });
    expect(parseTriggerInput({ ...session(), limitMinutes: undefined, stopAtPr: undefined })).toMatchObject({ limitMinutes: 45, stopAtPr: true });
  });

  it("tells an unattended session so, and passes stop-at-pr on", () => {
    expect(runPrompt({ prompt: "Do it", name: "X", stopAtPr: true })).toMatch(/unattended[\s\S]*stop-at-pr/);
    expect(runPrompt({ prompt: "Do it", name: "X", stopAtPr: false })).not.toMatch(/stop-at-pr/);
  });
});

describe("Scheduler", () => {
  let dir: string;
  let now: number;
  let tmux: FakeTmux;
  let store: ReturnType<typeof memoryStore>;
  let sessions: RunSession[];
  let room: string | null;
  let screen: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "triggers-"));
    now = T0;
    tmux = new FakeTmux();
    store = memoryStore();
    sessions = [];
    room = null;
    screen = "❯ ";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function scheduler() {
    return new Scheduler({
      store,
      tmux: tmux.runner,
      exitDir: dir,
      room: () => room,
      sessions: () => sessions,
      capture: async () => screen,
      atPrompt: (s) => s.trim() === "❯",
      now: () => now,
    });
  }

  it("a rule fires every second", async () => {
    const s = scheduler();
    const t = s.create(rule());
    for (let i = 0; i < 5; i++) {
      now += 1_000;
      await s.tick();
    }
    expect(s.runs(t.id).map((r) => r.status)).toEqual(["ran", "ran", "ran", "ran", "ran"]);
    expect(t.next).toBe(now + 1_000);
  });

  it("keeps a bounded number of Runs per Trigger", async () => {
    const s = scheduler();
    const t = s.create(rule());
    for (let i = 0; i < RUNS_KEPT + 10; i++) {
      now += 1_000;
      await s.tick();
    }
    expect(s.runs(t.id)).toHaveLength(RUNS_KEPT);
  });

  it("a once Trigger fires on its date and is done", async () => {
    const s = scheduler();
    const t = s.create(rule({ when: { type: "once", at: T0 + 10_000 } }));
    now += 5_000;
    await s.tick();
    expect(s.runs(t.id)).toHaveLength(0);
    now += 5_000;
    await s.tick();
    expect(s.runs(t.id)).toHaveLength(1);
    expect(t.next).toBeNull();
    now += 60_000;
    await s.tick();
    expect(s.runs(t.id)).toHaveLength(1);
  });

  it("a weekly Trigger fires at its time", async () => {
    const s = scheduler();
    const t = s.create(rule({ when: { type: "weekly", days: [1], time: "09:01" } }));
    now = new Date(2026, 10, 9, 9, 1, 0).getTime();
    await s.tick();
    expect(s.runs(t.id).map((r) => r.status)).toEqual(["ran"]);
    expect(new Date(t.next!)).toEqual(new Date(2026, 10, 16, 9, 1));
  });

  it("starts a session Run in tmux with its limit, its id and the prompt", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const [run] = s.runs(t.id);
    expect(run).toMatchObject({ status: "running", target: "runs-scratch:run-nightly-check" });
    const command = [...tmux.windows.values()][0];
    expect(command).toContain(`CLAUDE_MUX_RUN=${run.id}`);
    expect(command).toContain("timeout --foreground -k 10 2700 claude --dangerously-skip-permissions");
    expect(command).toContain("Look for broken links");
    expect(command).toContain(`${run.id}.exit`);
  });

  it("skips a firing while the last Run still goes", async () => {
    const s = scheduler();
    const t = s.create(session({ when: { type: "every", n: 10, unit: "minute" } }));
    now += 10 * 60_000;
    await s.tick();
    now += 10 * 60_000;
    await s.tick();
    expect(s.runs(t.id).map((r) => [r.status, r.reason])).toEqual([
      ["skipped", "The last Run was still going"],
      ["running", "Running"],
    ]);
    expect(tmux.windows.size).toBe(1);
  });

  it("skips a session the worker queue has no room for, with its reason", async () => {
    const s = scheduler();
    const t = s.create(session());
    room = "At the limit: 8 of 8 running";
    now += 3_600_000;
    await s.tick();
    expect(s.runs(t.id)[0]).toMatchObject({ status: "skipped", reason: "At the limit: 8 of 8 running" });
    expect(tmux.windows.size).toBe(0);
  });

  it("closes a Run whose turn ended at an empty prompt, and records it done", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const [run] = s.runs(t.id);
    sessions = [{ id: "sess-1", runId: run.id, target: "runs-scratch:1.0", state: "busy", turnCompletedAt: null, backgroundTasks: 0 }];
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent).toHaveLength(0);
    expect(s.runs(t.id)[0].sessionId).toBe("sess-1");

    sessions[0] = { ...sessions[0], state: "idle", turnCompletedAt: now };
    screen = "Allow this?\n❯ 1. Yes";
    now += RUN_CHECK_MS;
    await s.tick();
    // A dialog on screen: nothing typed into it.
    expect(tmux.sent).toHaveLength(0);

    screen = "❯ ";
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent.map((a) => a.at(-1))).toEqual(["/exit", "Enter"]);

    // The pane exits 0 and closes.
    writeFileSync(join(dir, `${run.id}.exit`), "0\n");
    tmux.close("@1");
    sessions = [];
    now += RUN_CHECK_MS;
    await s.tick();
    expect(s.runs(t.id)[0]).toMatchObject({ status: "done", reason: "Finished, and the session was closed" });
  });

  it("records a Run its limit stopped", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const [run] = s.runs(t.id);
    writeFileSync(join(dir, `${run.id}.exit`), "124\n");
    tmux.close("@1");
    now += 45 * 60_000;
    await s.tick();
    expect(s.runs(t.id)[0]).toMatchObject({ status: "timed-out", reason: "Stopped at its 45-minute limit" });
  });

  it("kills a pane that stays open after /exit", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const [run] = s.runs(t.id);
    sessions = [{ id: "sess-1", runId: run.id, target: null, state: "idle", turnCompletedAt: now + 1, backgroundTasks: 0 }];
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent).toHaveLength(2);
    now += CLOSE_WAIT_MS + RUN_CHECK_MS;
    await s.tick();
    expect(tmux.killed).toEqual(["@1"]);
    now += RUN_CHECK_MS;
    await s.tick();
    expect(s.runs(t.id)[0]).toMatchObject({ status: "ended" });
  });

  it("skips and records a clock firing missed while the server was down", async () => {
    const first = scheduler();
    const t = first.create(rule({ when: { type: "every", n: 1, unit: "minute" } }));
    now += 60_000;
    await first.tick();
    // Down for ten minutes.
    now += 10 * 60_000 + 30_000;
    const second = scheduler();
    await second.tick();
    const runs = second.runs(t.id);
    expect(runs.map((r) => r.status)).toEqual(["skipped", "ran"]);
    expect(runs[0].reason).toBe("Missed 10 firings while the server was down");
    // And it carries on from now, not from where it stopped.
    expect(second.triggers()[0].next).toBe(T0 + 12 * 60_000);
  });

  it("a firing a little late still runs", async () => {
    const s = scheduler();
    const t = s.create(rule({ when: { type: "every", n: 1, unit: "minute" } }));
    now += 60_000 + GRACE_MS - 1;
    await s.tick();
    expect(s.runs(t.id).map((r) => r.status)).toEqual(["ran"]);
  });

  it("across a restart keeps its Triggers, follows the Run still going, and fails one that never started", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const running = s.runs(t.id)[0];
    // A Run recorded but whose window the server never got to start.
    store.file!.runs.unshift({ id: "r-lost", trigger: t.id, at: now, status: "running", reason: "Starting" });

    now += 60_000;
    const after = scheduler();
    expect(after.triggers()).toHaveLength(1);
    expect(after.runs(t.id).find((r) => r.id === "r-lost")).toMatchObject({ status: "failed" });
    // The window lived on in tmux; it is still followed and still blocks a second Run.
    now = T0 + 2 * 3_600_000;
    await after.tick();
    expect(after.runs(t.id)[0]).toMatchObject({ status: "skipped", reason: "The last Run was still going" });
    writeFileSync(join(dir, `${running.id}.exit`), "0\n");
    tmux.close("@1");
    now += RUN_CHECK_MS;
    await after.tick();
    expect(after.runs(t.id).find((r) => r.id === running.id)).toMatchObject({ status: "done" });
  });

  it("a paused Trigger does not fire, and resumes from now without missed firings", async () => {
    const s = scheduler();
    const t = s.create(rule({ when: { type: "every", n: 1, unit: "minute" } }));
    s.setPaused(t.id, true);
    now += 10 * 60_000;
    await s.tick();
    expect(s.runs(t.id)).toHaveLength(0);
    s.setPaused(t.id, false);
    await s.tick();
    expect(s.runs(t.id)).toHaveLength(0);
    expect(s.triggers()[0].next).toBe(T0 + 11 * 60_000);
  });
});

describe("event Triggers", () => {
  it("lists each enabled project's events that are not ignored, with their Runs", () => {
    const views = eventTriggers({
      projects: [
        { repo: "u/a", root: "/p/a", enabled: true, events: { "issue-ready": "session", push: "rule" } },
        { repo: "u/b", root: "/p/b", enabled: true, events: { "issue-ready": "ignore", push: "ignore" } },
        { repo: "u/c", root: "/p/c", enabled: false, events: { "issue-ready": "rule", push: "rule" } },
      ],
      seen: [
        { at: 3, repo: "u/a", kind: "push", action: "rule", outcome: "Recorded as seen", title: "abc1234 fix", url: "https://github.com/u/a/commit/abc" },
        { at: 2, repo: "u/a", kind: "issue-ready", action: "session", outcome: "Queued for a worker", title: "#7 Thing", url: "https://github.com/u/a/issues/7" },
      ],
      queue: [
        { at: 5, repo: "u/a", number: 7, what: "Started in queue-a:mw-7-thing" },
        { at: 4, repo: "u/a", number: 7, what: "Another machine claimed it (m2)" },
        { at: 4, repo: "u/b", number: 1, what: "Started in queue-b:mw-1" },
      ],
    });
    expect(views.map((v) => v.id)).toEqual(["event:u/a:issue-ready", "event:u/a:push"]);
    const ready = views[0];
    expect(ready).toMatchObject({ what: "session", editable: false });
    expect(ready.runs.map((r) => [r.status, r.reason])).toEqual([
      ["running", "Started in queue-a:mw-7-thing"],
      ["skipped", "Another machine claimed it (m2)"],
      ["ran", "Queued for a worker"],
    ]);
    expect(ready.runs[0].link?.href).toBe("https://github.com/u/a/issues/7");
    expect(views[1].runs).toEqual([
      { at: 3, status: "ran", reason: "Recorded as seen", link: { kind: "github", href: "https://github.com/u/a/commit/abc", label: "abc1234 fix" } },
    ]);
  });
});
