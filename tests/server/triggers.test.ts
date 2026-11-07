import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPaneReadyForCommand } from "../../src/tmux/pane.js";
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

  it("every N days keeps its local time across a change of summer time", () => {
    // Whatever this machine's zone, the firings land at the anchor's local hour.
    const anchor = new Date(2026, 2, 1, 9, 0).getTime();
    const daily = { type: "every" as const, n: 1, unit: "day" as const };
    let at = anchor;
    for (let i = 0; i < 300; i++) {
      at = nextFiring(daily, at, anchor)!;
      const d = new Date(at);
      expect([d.getHours(), d.getMinutes()]).toEqual([9, 0]);
    }
    expect(new Date(at)).toEqual(new Date(2026, 2, 301, 9, 0));
    expect(new Date(nextFiring({ type: "every", n: 3, unit: "day" }, anchor + 4 * 86_400_000, anchor)!)).toEqual(new Date(2026, 2, 7, 9, 0));
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

  it("refuses a once date that has passed", () => {
    expect(parseTriggerInput(rule({ when: { type: "once", at: T0 - 1 } }), T0)).toMatch(/passed/);
    expect(parseTriggerInput(rule({ when: { type: "once", at: T0 + 1 } }), T0)).toMatchObject({ what: "rule" });
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
  let on: boolean;
  let screen: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "triggers-"));
    now = T0;
    tmux = new FakeTmux();
    store = memoryStore();
    sessions = [];
    room = null;
    on = true;
    screen = "❯ ";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function scheduler() {
    return new Scheduler({
      store,
      tmux: tmux.runner,
      exitDir: dir,
      on: () => on,
      room: () => room,
      sessions: () => sessions,
      capture: async () => screen,
      atPrompt: (s) => s.trim() === "❯",
      typed: (s) => s.replace(/^❯/, "").trim() || null,
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

  it("skips rule and session firings while the machine's switch is off, counting them as one entry", async () => {
    const s = scheduler();
    const r = s.create(rule());
    const t = s.create(session());
    on = false;
    for (let i = 0; i < 3; i++) {
      now += 1_000;
      await s.tick();
    }
    expect(s.runs(r.id)).toMatchObject([{ status: "skipped", reason: "Off on this machine", count: 3 }]);
    now = T0 + 3_600_000;
    await s.tick();
    expect(s.runs(t.id)).toMatchObject([{ status: "skipped", reason: "Off on this machine" }]);
    expect(tmux.windows.size).toBe(0);

    on = true;
    now += 1_000;
    await s.tick();
    expect(s.runs(r.id)[0]).toMatchObject({ status: "ran" });
  });

  it("leaves a session Run going when the switch goes off, and still closes it when it ends", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const [run] = s.runs(t.id);
    on = false;
    sessions = [{ id: "sess-1", runId: run.id, target: "runs-scratch:1.0", state: "busy", turnCompletedAt: null, backgroundTasks: 0 }];
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.killed).toEqual([]);
    expect(s.runs(t.id)[0]).toMatchObject({ status: "running", sessionId: "sess-1" });
    sessions[0] = { ...sessions[0], state: "idle", turnCompletedAt: now };
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent.map((a) => a.at(-1))).toEqual(["Escape", "/exit", "Enter"]);
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
    expect(tmux.sent.map((a) => a.at(-1))).toEqual(["Escape", "/exit", "Enter"]);

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
    expect(tmux.sent).toHaveLength(3);
    now += CLOSE_WAIT_MS + RUN_CHECK_MS;
    await s.tick();
    expect(tmux.killed).toEqual(["@1"]);
    now += RUN_CHECK_MS;
    await s.tick();
    expect(s.runs(t.id)[0]).toMatchObject({ status: "ended", reason: expect.stringMatching(/did not close after \/exit/) });
  });

  it("records a Run it had to kill at its limit as timed out, by the limit the Run started with", async () => {
    const s = scheduler();
    const t = s.create(session({ limitMinutes: 240 }));
    now += 3_600_000;
    await s.tick();
    // Deleted while it runs: the Run keeps its own limit, and is followed to its end.
    s.remove(t.id);
    now += 60 * 60_000;
    await s.tick();
    expect(tmux.killed).toEqual([]);
    now += 182 * 60_000;
    await s.tick();
    expect(tmux.killed).toEqual(["@1"]);
    // Gone, and with no Trigger left to show it under, it is dropped.
    expect(store.file!.runs).toHaveLength(1);
    now += RUN_CHECK_MS;
    await s.tick();
    expect(store.file!.runs).toHaveLength(0);
  });

  it("records a killed Run as timed out when its Trigger is still there", async () => {
    const s = scheduler();
    const t = s.create(session({ when: { type: "every", n: 1, unit: "day" }, limitMinutes: 10 }));
    now += 86_400_000;
    await s.tick();
    now += 12 * 60_000;
    await s.tick();
    now += RUN_CHECK_MS;
    await s.tick();
    expect(s.runs(t.id)[0]).toMatchObject({ status: "timed-out", reason: "Stopped at its 10-minute limit" });
  });

  it("does not start a session whose Trigger was paused before its start came round", async () => {
    let paused = false;
    const s = new Scheduler({
      store,
      tmux: async (args) => {
        // The first start is slow; the second Trigger is paused meanwhile.
        if (args[0] === "has-session" && !paused) {
          paused = true;
          s.setPaused(second.id, true);
        }
        return tmux.runner(args);
      },
      exitDir: dir,
      on: () => true,
      room: () => null,
      sessions: () => [],
      capture: async () => "",
      atPrompt: () => false,
      typed: () => null,
      now: () => now,
    });
    const first = s.create(session({ name: "First" }));
    const second = s.create(session({ name: "Second" }));
    now += 3_600_000;
    await s.tick();
    expect(s.runs(first.id)[0].status).toBe("running");
    expect(s.runs(second.id)[0]).toMatchObject({ status: "skipped", reason: "Paused before it started" });
    expect(tmux.windows.size).toBe(1);
  });

  it("survives a tick that fails", async () => {
    const s = new Scheduler({
      store: { load: () => ({ v: 1, triggers: [], runs: [] }), save: () => { throw new Error("disk full"); } },
      tmux: tmux.runner,
      exitDir: dir,
      on: () => true,
      room: () => null,
      sessions: () => [],
      capture: async () => "",
      atPrompt: () => false,
      typed: () => null,
      now: () => now,
    });
    expect(() => s.create(rule())).toThrow("disk full");
    now += 1_000;
    await expect(s.tick()).resolves.toBeUndefined();
    expect(s.lastError).toBe("disk full");
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
    expect(runs[0]).toMatchObject({ reason: "Missed while the server was down", count: 10 });
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

  it("has the firing on disk before the window opens, so a restart opens nothing twice and a once does not fire again", async () => {
    let seen: TriggersFile | null = null;
    const s = new Scheduler({
      store,
      tmux: async (args) => {
        if (args[0] === "new-window" || args[0] === "new-session") seen = JSON.parse(JSON.stringify(store.file));
        return tmux.runner(args);
      },
      exitDir: dir,
      on: () => true,
      room: () => null,
      sessions: () => [],
      capture: async () => "",
      atPrompt: () => false,
      typed: () => null,
      now: () => now,
    });
    const t = s.create(session({ when: { type: "once", at: T0 + 60_000 } }));
    now += 60_000;
    await s.tick();
    expect(seen).not.toBeNull();
    expect(seen!.triggers[0].next).toBeNull();
    expect(seen!.runs[0]).toMatchObject({ trigger: t.id, status: "running" });
    expect(seen!.runs[0].window).toBeUndefined();
    expect(store.file!.runs[0].window).toBeDefined();

    // The server stops right there: on restart the Run fails, and nothing fires again.
    store.file = seen;
    const after = scheduler();
    now += 1_000;
    await after.tick();
    expect(after.runs(t.id)).toHaveLength(1);
    expect(after.runs(t.id)[0]).toMatchObject({ status: "failed" });
    expect(tmux.windows.size).toBe(1);
  });

  it("counts again from now after the clock ran ahead and came back", async () => {
    // Created while the clock read a day ahead.
    now = T0 + 86_400_000;
    const first = scheduler();
    const t = first.create(rule({ when: { type: "every", n: 1, unit: "hour" } }));
    expect(t.next).toBe(T0 + 86_400_000 + 3_600_000);
    now = T0;
    const s = scheduler();
    await s.tick();
    expect(s.triggers()[0].next).toBe(T0 + 3_600_000);
    expect(s.triggers()[0].createdAt).toBe(T0);
    now += 3_600_000;
    await s.tick();
    expect(s.runs(t.id).map((r) => r.status)).toEqual(["ran"]);
  });

  it("counts a weekly Trigger again from now when its next firing is further off than a week", async () => {
    const s = scheduler();
    const t = s.create(rule({ when: { type: "weekly", days: [1], time: "09:01" } }));
    t.next = T0 + 30 * 86_400_000;
    await s.tick();
    expect(new Date(s.triggers()[0].next!)).toEqual(new Date(2026, 10, 9, 9, 1));
  });

  it("does not type /exit into a box holding a draft, and sends Enter again when /exit stays in the box", async () => {
    const s = scheduler();
    const t = s.create(session());
    now += 3_600_000;
    await s.tick();
    const [run] = s.runs(t.id);
    sessions = [{ id: "sess-1", runId: run.id, target: null, state: "idle", turnCompletedAt: now + 1, backgroundTasks: 0 }];
    screen = "❯ /exit";
    now += RUN_CHECK_MS;
    await s.tick();
    // Something is typed: the scheduler's atPrompt says no.
    expect(tmux.sent).toHaveLength(0);
    screen = "❯ ";
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent.map((a) => a.at(-1))).toEqual(["Escape", "/exit", "Enter"]);
    // The Enter was folded into the text: `/exit` still sits in the box.
    screen = "❯ /exit";
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent.map((a) => a.at(-1))).toEqual(["Escape", "/exit", "Enter", "Enter"]);
    // Only once.
    now += RUN_CHECK_MS;
    await s.tick();
    expect(tmux.sent).toHaveLength(4);
  });

  it("counts skips for the same reason as one entry, and keeps the Runs that ran", async () => {
    const s = scheduler();
    const t = s.create(session({ when: { type: "every", n: 1, unit: "minute" }, limitMinutes: 600 }));
    now += 60_000;
    await s.tick();
    for (let i = 0; i < RUNS_KEPT + 20; i++) {
      now += 60_000;
      await s.tick();
    }
    const runs = s.runs(t.id);
    expect(runs.map((r) => [r.status, r.count])).toEqual([
      ["skipped", RUNS_KEPT + 20],
      ["running", undefined],
    ]);
    expect(runs[0].at).toBe(now);
  });

  it("keeps the Runs that ran apart from a long run of skips", async () => {
    const first = scheduler();
    const t = first.create(rule({ when: { type: "every", n: 1, unit: "minute" } }));
    // One Run that ran, under skips for reasons that differ each time.
    store.file!.runs = [
      ...Array.from({ length: RUNS_KEPT + 5 }, (_, i) => ({ id: `r-s${i}`, trigger: t.id, at: T0 - i, status: "skipped" as const, reason: `Held ${i}` })),
      { id: "r-ran", trigger: t.id, at: T0 - 1_000, status: "ran" as const, reason: "Recorded" },
    ];
    const s = scheduler();
    now += 60_000;
    await s.tick();
    const runs = s.runs(t.id);
    expect(runs.filter((r) => r.status === "skipped")).toHaveLength(RUNS_KEPT);
    expect(runs.filter((r) => r.status === "ran").map((r) => r.id)).toEqual([expect.any(String), "r-ran"]);
  });

  it("records the firings a tick that ran long passed", async () => {
    const s = scheduler();
    const t = s.create(rule());
    now += 4_000;
    await s.tick();
    expect(s.runs(t.id).map((r) => [r.status, r.reason])).toEqual([
      ["skipped", "Missed while a tick ran late"],
      ["ran", "Recorded"],
    ]);
    expect(s.runs(t.id)[0].count).toBe(3);
    expect(t.next).toBe(now + 1_000);
    // Slow again: counted into the same entry, the Runs that ran between left as they are.
    now += 3_000;
    await s.tick();
    expect(s.runs(t.id).map((r) => [r.status, r.count])).toEqual([
      ["ran", undefined],
      ["skipped", 5],
      ["ran", undefined],
    ]);
  });

  it("records a paused once Trigger whose date passed", async () => {
    const s = scheduler();
    const t = s.create(rule({ when: { type: "once", at: T0 + 60_000 } }));
    s.setPaused(t.id, true);
    now += 2 * 60_000;
    await s.tick();
    expect(s.runs(t.id).map((r) => [r.status, r.reason])).toEqual([["skipped", "Paused at its date"]]);
    await s.tick();
    expect(s.runs(t.id)).toHaveLength(1);
    s.setPaused(t.id, false);
    expect(s.triggers()[0].next).toBeNull();
  });
});

describe("event Triggers", () => {
  it("shows what the release rule did as Runs of claude-mux's push, and nowhere else", () => {
    const release = [{ at: 9, status: "failed" as const, reason: "abc1234: test failed; filed #5", url: "https://github.com/christinoleo/claude-mux/issues/5" }];
    const views = eventTriggers({
      projects: [
        { repo: "christinoleo/claude-mux", root: "/p/cm", enabled: true, events: { "issue-ready": "ignore", push: "rule" } },
        { repo: "u/a", root: "/p/a", enabled: true, events: { "issue-ready": "ignore", push: "rule" } },
      ],
      seen: [],
      queue: [],
      release,
    });
    expect(views[0].runs).toEqual([
      { at: 9, status: "failed", reason: "abc1234: test failed; filed #5", link: { kind: "github", href: release[0].url, label: "GitHub" } },
    ]);
    expect(views[1].runs).toEqual([]);
  });

  it("shows an event the poller saw while the machine was off as skipped", () => {
    const [view] = eventTriggers({
      projects: [{ repo: "u/a", root: "/p/a", enabled: true, events: { "issue-ready": "ignore", push: "rule" } }],
      seen: [{ at: 3, repo: "u/a", kind: "push", action: "rule", outcome: "Off on this machine", skipped: true, title: "abc1234 fix", url: "u" }],
      queue: [],
    });
    expect(view.runs.map((r) => [r.status, r.reason])).toEqual([["skipped", "Off on this machine"]]);
  });

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
    expect(ready).toMatchObject({ what: "session", kind: "event" });
    expect(ready.runs.map((r) => [r.status, r.reason])).toEqual([
      ["ran", "Started in queue-a:mw-7-thing"],
      ["skipped", "Another machine claimed it (m2)"],
      ["ran", "Queued for a worker"],
    ]);
    expect(ready.runs[0].link?.href).toBe("https://github.com/u/a/issues/7");
    expect(views[1].runs).toEqual([
      { at: 3, status: "ran", reason: "Recorded as seen", link: { kind: "github", href: "https://github.com/u/a/commit/abc", label: "abc1234 fix" } },
    ]);
  });
});

describe("isPaneReadyForCommand", () => {
  const SEP = "─".repeat(80);
  const pane = (box: string[]) => ["  earlier output", SEP, ...box, SEP, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

  it("takes an empty prompt", () => {
    expect(isPaneReadyForCommand(pane(["❯  "]))).toBe(true);
  });

  it("refuses a box holding a draft, even one the box reader bails on", () => {
    expect(isPaneReadyForCommand(pane(["❯ fix the tests"]))).toBe(false);
    expect(isPaneReadyForCommand(pane(["❯ steps", "  1. run it"]))).toBe(false);
  });
});
