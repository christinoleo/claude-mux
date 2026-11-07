import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WorkerQueue,
  DEFAULT_SETTINGS,
  RELEASE_MARK,
  CLAIM_WINDOW_MS,
  parseSettingsPatch,
  winningClaim,
  sumTrees,
  checkoutProblem,
  START_ATTEMPTS,
  type HistoryStore,
  type LiveWorker,
  type WorkerRun,
  type Marker,
  type MemoryReading,
  type QueueDeps,
  type QueueFile,
  type QueueGithub,
  type QueueStore,
  type TmuxRunner,
} from "../../src/server/worker-queue.js";
import type { ReadyIssue } from "../../src/server/github-events.js";
import { exclusiveList, nameList } from "../../src/worker-placement.js";

/** One GitHub that several machines' queues share, so they can race on it. */
class FakeGithub {
  issues = new Map<string, { open: boolean; labels: Set<string>; updatedAt: string }>();
  /** addLabel() fails while this is above zero, counting down. */
  failLabels = 0;
  comments: { repo: string; number: number; id: number; body: string; at: number }[] = [];
  /** The clock comments are stamped with. */
  clock = Date.parse("2026-11-07T12:00:00Z");
  /** markers() fails while this is above zero, counting down. */
  failMarkers = 0;
  private nextId = 1000;
  /** Comments posted but not yet readable, as GitHub can lag; released by `settle()`. */
  hidden = new Set<number>();
  lagging = false;
  /** Comments left out of this many more markers() reads each, however long one waits: a list that lags. */
  hideReads = new Map<number, number>();

  add(repo: string, number: number, labels: string[] = ["ready-for-agent"]): void {
    this.issues.set(`${repo}#${number}`, { open: true, labels: new Set(labels), updatedAt: "2026-11-07T11:00:00Z" });
  }

  get(repo: string, number: number) {
    return this.issues.get(`${repo}#${number}`)!;
  }

  settle(): void {
    this.hidden.clear();
  }

  api(): QueueGithub {
    return {
      issue: async (repo, number) => {
        const i = this.issues.get(`${repo}#${number}`);
        return i ? { open: i.open, labels: [...i.labels], updatedAt: i.updatedAt } : null;
      },
      comment: async (repo, number, body) => {
        const id = this.nextId++;
        this.comments.push({ repo, number, id, body, at: this.clock });
        if (this.lagging) this.hidden.add(id);
        return id;
      },
      deleteComment: async (_repo, id) => {
        this.comments = this.comments.filter((c) => c.id !== id);
        return true;
      },
      markers: async (repo, number): Promise<Marker[] | null> => {
        if (this.failMarkers > 0) {
          this.failMarkers--;
          return null;
        }
        const shown = this.comments.filter((c) => {
          if (c.repo !== repo || c.number !== number || !c.body.includes("<!-- claude-mux:") || this.hidden.has(c.id)) return false;
          const left = this.hideReads.get(c.id) ?? 0;
          if (left > 0) this.hideReads.set(c.id, left - 1);
          return left === 0;
        });
        return shown.map(({ id, body, at }) => ({ id, body, at }));
      },
      addLabel: async (repo, number, label) => {
        if (this.failLabels > 0) {
          this.failLabels--;
          return false;
        }
        this.get(repo, number).labels.add(label);
        return true;
      },
      removeLabel: async (repo, number, label) => {
        this.get(repo, number).labels.delete(label);
        return true;
      },
    };
  }
}

/** One machine's tmux: windows by id, and the commands it was asked to run. */
class FakeTmux {
  /** Open windows as `<server pid> <id> <name>`. */
  windows = new Set<string>();
  server = "4242";
  sessions = new Set<string>();
  started: { args: string[]; window: string }[] = [];
  killed: string[] = [];
  private next = 1;

  runner(): TmuxRunner {
    return async (args) => {
      switch (args[0]) {
        case "list-windows":
          return { ok: true, stdout: [...this.windows].join("\n") };
        case "restart": {
          // Not a tmux command: the server restarted, and window ids count from the start again.
          this.windows.clear();
          this.server = "5151";
          this.next = 1;
          return { ok: true, stdout: "" };
        }
        case "has-session":
          return { ok: this.sessions.has(args[2].slice(1)), stdout: "" };
        case "new-session":
        case "new-window": {
          const window = `@${this.next++}`;
          const name = args[args.indexOf("-n") + 1];
          if (args[0] === "new-session") this.sessions.add(args[args.indexOf("-s") + 1]);
          this.windows.add(`${this.server} ${window} ${name}`);
          this.started.push({ args, window });
          return { ok: true, stdout: `${this.server} ${window}\n` };
        }
        case "kill-window":
          for (const w of this.windows) if (w.split(" ")[1] === args[2]) this.windows.delete(w);
          this.killed.push(args[2]);
          return { ok: true, stdout: "" };
        default:
          return { ok: false, stdout: "" };
      }
    };
  }
}

function memoryStore(file?: Partial<QueueFile>): QueueStore & { file: QueueFile } {
  const store = {
    file: { v: 1 as const, settings: { ...DEFAULT_SETTINGS, enabled: true }, workers: [], retried: [], log: [], ...file },
    load() {
      return structuredClone(store.file);
    },
    save(f: QueueFile) {
      store.file = structuredClone(f);
    },
  };
  return store;
}

function ready(repo: string, number: number, extra: Partial<ReadyIssue> = {}): ReadyIssue {
  return {
    repo,
    root: `/home/leo/Projects/${repo.split("/")[1]}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    labels: ["ready-for-agent"],
    blockedBy: 0,
    // Filled from the fake GitHub by `machine()` unless a test gives one.
    updatedAt: "",
    ...extra,
  };
}

interface Machine {
  queue: WorkerQueue;
  tmux: FakeTmux;
  store: ReturnType<typeof memoryStore>;
  git: string[][];
}

function machine(
  github: FakeGithub,
  issues: () => ReadyIssue[],
  opts: Partial<QueueDeps> & { name?: string; file?: Partial<QueueFile>; live?: LiveWorker[] } = {}
): Machine {
  const tmux = new FakeTmux();
  const store = memoryStore(opts.file);
  const git: string[][] = [];
  const queue = new WorkerQueue({
    store,
    machine: () => opts.name ?? "omarchy",
    machineId: `id-${opts.name ?? "omarchy"}`,
    ready: () =>
      // What the poller would report: its labels as GitHub holds them now.
      issues().map((i) => {
        const now = github.issues.get(`${i.repo}#${i.number}`);
        return { ...i, labels: [...(now?.labels ?? i.labels)], updatedAt: i.updatedAt || (now?.updatedAt ?? "") };
      }),
    github: github.api(),
    tmux: tmux.runner(),
    git: async (cwd, args) => {
      git.push([cwd, ...args]);
      return true;
    },
    memory: () => ({ availableGiB: 20, pressure: 0 }),
    liveWorkers: () => opts.live ?? [],
    placement: () => null,
    keptBy: () => null,
    checkout: async () => null,
    wanted: () => true,
    machineGone: () => false,
    sleep: async () => github.settle(),
    ...withoutLocal(opts),
  });
  return { queue, tmux, store, git };
}

function withoutLocal(opts: Partial<QueueDeps> & { name?: string; file?: unknown; live?: unknown }): Partial<QueueDeps> {
  const deps: Partial<QueueDeps> & { name?: string; file?: unknown; live?: unknown } = { ...opts };
  delete deps.name;
  delete deps.file;
  delete deps.live;
  return deps;
}

const REPO = "christinoleo/scratch";

describe("parseSettingsPatch", () => {
  it("takes the switch and the numbers within bounds", () => {
    expect(parseSettingsPatch({ enabled: true, limit: 8, minFreeGiB: 2.5, maxPressure: 10 })).toEqual({
      enabled: true,
      limit: 8,
      minFreeGiB: 2.5,
      maxPressure: 10,
    });
    expect(parseSettingsPatch({ limit: 2.5 })).toBe("limit must be a whole number");
    expect(parseSettingsPatch({ limit: -1 })).toMatch(/limit must be/);
    expect(parseSettingsPatch({ enabled: "yes" })).toMatch(/enabled/);
  });

  it("is off by default, with 8 workers and a 2.5 GiB floor", () => {
    expect(DEFAULT_SETTINGS).toEqual({ enabled: false, limit: 8, minFreeGiB: 2.5, maxPressure: 10 });
  });
});

describe("winningClaim", () => {
  const T = Date.parse("2026-11-07T12:00:00Z");
  const m = (id: number, body: string, at = T) => ({ id, body, at });

  it("is the earliest claim since the last release", () => {
    expect(winningClaim([m(3, "<!-- claude-mux:claim b -->"), m(2, "<!-- claude-mux:claim a -->")], 3)?.id).toBe(2);
    expect(
      winningClaim([m(1, "<!-- claude-mux:claim a -->"), m(2, RELEASE_MARK), m(4, "<!-- claude-mux:claim b -->")], 4)?.id
    ).toBe(4);
  });

  it("lets an old claim lapse only when its machine is gone, never on age alone", () => {
    const stale = m(1, "<!-- claude-mux:claim a -->", T - CLAIM_WINDOW_MS - 1);
    const fresh = m(9, "<!-- claude-mux:claim b -->");
    expect(winningClaim([stale, fresh], 9)?.id).toBe(1);
    expect(winningClaim([stale, fresh], 9, { gone: () => false })?.id).toBe(1);
    expect(winningClaim([stale, fresh], 9, { gone: (id) => id === "a" })?.id).toBe(9);
  });

  it("never lets a young claim lapse, even from a machine that looks gone", () => {
    const young = m(1, "<!-- claude-mux:claim a -->", T - 1000);
    expect(winningClaim([young, m(9, "<!-- claude-mux:claim b -->")], 9, { gone: () => true })?.id).toBe(1);
  });

  it("lets every other claim by this machine lapse, however young: it runs no worker on the issue", () => {
    const left = m(1, "<!-- claude-mux:claim b -->", T - 1000);
    expect(winningClaim([left, m(9, "<!-- claude-mux:claim b -->")], 9, { self: "b" })?.id).toBe(9);
  });

  it("knows nothing until its own claim can be read back", () => {
    expect(winningClaim([m(2, "<!-- claude-mux:claim a -->")], 3)).toBeNull();
  });
});

describe("WorkerQueue", () => {
  it("starts nothing while the machine's switch is off", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    const m = machine(github, () => [ready(REPO, 1)], { file: { settings: { ...DEFAULT_SETTINGS } } });
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(m.queue.status().waiting).toMatchObject([{ number: 1, why: "Off on this machine" }]);
  });

  it("answers a Trigger's Run by the same limit and memory brake, whatever the switch says", async () => {
    const github = new FakeGithub();
    const live: LiveWorker[] = Array.from({ length: 7 }, () => ({ issue: null, cwd: "/p" }));
    let free = 20;
    const m = machine(github, () => [], {
      file: { settings: { ...DEFAULT_SETTINGS } },
      live,
      memory: () => ({ availableGiB: free, pressure: 0 }),
    });
    expect(m.queue.room()).toBeNull();
    expect(m.queue.room(1)).toBe("At the limit: 8 of 8 running");
    free = 1;
    expect(m.queue.room()).toMatch(/1\.0 GiB free, under 2\.5 GiB/);
  });

  it("starts a worker as the daemon did: labelled in-progress, a tmux window running claude with the maestro environment", async () => {
    const github = new FakeGithub();
    github.add(REPO, 7);
    const m = machine(github, () => [ready(REPO, 7, { title: "Add a thing!" })]);
    await m.queue.tick();
    expect(github.get(REPO, 7).labels.has("in-progress")).toBe(true);
    expect(m.tmux.started).toHaveLength(1);
    const { args } = m.tmux.started[0];
    expect(args.slice(0, 2)).toEqual(["new-session", "-d"]);
    expect(args).toContain("queue-scratch");
    expect(args).toContain("mw-7-add-a-thing");
    expect(args[args.indexOf("-c") + 1]).toBe("/home/leo/Projects/scratch");
    const command = args.at(-1)!;
    expect(command).toMatch(/^env -u CLAUDECODE MAESTRO_ROLE=worker MAESTRO_ISSUE=7 claude .*--dangerously-skip-permissions '\/ak:maestro-worker 7'$/);
    expect(m.queue.status().workers).toMatchObject([{ repo: REPO, number: 7, window: "@1", server: "4242", name: "mw-7-add-a-thing" }]);
    // The second worker for the same project joins its tmux session.
    github.add(REPO, 8);
    const m2 = machine(github, () => [ready(REPO, 8)]);
    m2.tmux.sessions.add("queue-scratch");
    await m2.queue.tick();
    expect(m2.tmux.started[0].args[0]).toBe("new-window");
  });

  it("never claims an issue labelled stop-at-pr, since a worker could still merge it", async () => {
    const github = new FakeGithub();
    github.add(REPO, 3, ["ready-for-agent", "stop-at-pr"]);
    const m = machine(github, () => [ready(REPO, 3)]);
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(github.comments).toEqual([]);
    expect(m.queue.status().waiting[0].why).toMatch(/stop-at-pr/);
  });

  it("does not claim stop-at-pr even when the sweep has not seen the label yet", async () => {
    const github = new FakeGithub();
    github.add(REPO, 3, ["ready-for-agent", "stop-at-pr"]);
    const m = machine(github, () => [ready(REPO, 3)], {
      ready: () => [ready(REPO, 3, { updatedAt: github.get(REPO, 3).updatedAt })],
    });
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(github.comments).toEqual([]);
  });

  it("never takes an issue that is claimed, asking for help, a person's, on hold, or blocked", async () => {
    const github = new FakeGithub();
    const labels = ["in-progress", "needs-help", "ready-for-human", "hold"];
    labels.forEach((l, i) => github.add(REPO, i + 1, ["ready-for-agent", l]));
    github.add(REPO, 9);
    const m = machine(github, () => [...labels.map((_, i) => ready(REPO, i + 1)), ready(REPO, 9, { blockedBy: 2 })]);
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(m.queue.status().waiting.map((w) => w.why)).toEqual([
      "A worker owns it",
      "Its worker asked for help",
      "A person's task",
      "On hold",
      "Blocked by 2 open issues",
    ]);
  });

  it("re-reads the issue before claiming: a label the sweep has not seen yet stops it", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1, ["ready-for-agent", "in-progress"]);
    const m = machine(github, () => [ready(REPO, 1)], {
      ready: () => [ready(REPO, 1)], // the sweep's labels, a minute old
    });
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(github.comments).toHaveLength(0);
  });

  describe("the limit", () => {
    it("stops at the machine's limit, counting every live worker session here", async () => {
      const github = new FakeGithub();
      for (const n of [1, 2, 3, 4]) github.add(REPO, n);
      const m = machine(github, () => [1, 2, 3, 4].map((n) => ready(REPO, n)), {
        file: { settings: { ...DEFAULT_SETTINGS, enabled: true, limit: 3 } },
        // A daemon's worker on another repo counts too.
        live: [{ issue: 50, cwd: "/home/leo/Projects/other" }],
      });
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(2);
      expect(m.queue.status().running).toBe(3);
      expect(m.queue.status().hold).toBe("At the limit: 3 of 3 running");
      expect(m.queue.status().waiting.map((w) => [w.number, w.why])).toEqual([
        [3, "At the limit: 3 of 3 running"],
        [4, "At the limit: 3 of 3 running"],
      ]);
    });

    it("does not count its own worker twice once the hooks report its session", async () => {
      const github = new FakeGithub();
      github.add(REPO, 1);
      github.add(REPO, 2);
      let issues = [ready(REPO, 1)];
      const live: LiveWorker[] = [];
      const m = machine(github, () => issues, {
        file: { settings: { ...DEFAULT_SETTINGS, enabled: true, limit: 2 } },
        liveWorkers: () => live,
      });
      await m.queue.tick();
      live.push({ issue: 1, cwd: "/home/leo/Projects/scratch/.worktree/1" });
      issues = [ready(REPO, 1), ready(REPO, 2)];
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(2);
      expect(m.queue.status().running).toBe(2);
    });

    it("has no limit per project: one project can fill the machine", async () => {
      const github = new FakeGithub();
      const ns = Array.from({ length: 8 }, (_, i) => i + 1);
      for (const n of ns) github.add(REPO, n);
      const m = machine(github, () => ns.map((n) => ready(REPO, n)));
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(8);
    });
  });

  describe("the memory brake", () => {
    it("holds a start while free memory is under the floor, and stops nothing", async () => {
      const github = new FakeGithub();
      github.add(REPO, 1);
      github.add(REPO, 2);
      let memory: MemoryReading = { availableGiB: 10, pressure: 0 };
      let issues = [ready(REPO, 1)];
      const m = machine(github, () => issues, { memory: () => memory });
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(1);

      memory = { availableGiB: 2, pressure: 0 };
      issues = [ready(REPO, 1), ready(REPO, 2)];
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(1);
      expect(m.tmux.killed).toEqual([]);
      // The worker started a moment ago has not grown yet: its share counts as gone already.
      expect(m.queue.status().hold).toBe("Held: 0.6 GiB free, under 2.5 GiB");

      memory = { availableGiB: 2, pressure: 0 };
      m.queue.update({ minFreeGiB: 0.5 });
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(2);
    });

    it("holds a start under memory pressure", async () => {
      const github = new FakeGithub();
      github.add(REPO, 1);
      const m = machine(github, () => [ready(REPO, 1)], { memory: () => ({ availableGiB: 20, pressure: 12.5 }) });
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(0);
      expect(m.queue.status().hold).toBe("Held: memory pressure 12.5%, over 10%");
    });

    it("counts each start in one sweep against the memory it read, since workers grow after they start", async () => {
      const github = new FakeGithub();
      const ns = [1, 2, 3, 4, 5];
      for (const n of ns) github.add(REPO, n);
      // 6.5 GiB free falls to 2.3 after three starts of 1.4, under the 2.5 floor.
      const m = machine(github, () => ns.map((n) => ready(REPO, n)), { memory: () => ({ availableGiB: 6.5, pressure: 0 }) });
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(3);
    });

    it("does not brake where memory cannot be read", async () => {
      const github = new FakeGithub();
      github.add(REPO, 1);
      const m = machine(github, () => [ready(REPO, 1)], { memory: () => ({ availableGiB: null, pressure: null }) });
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(1);
    });
  });

  describe("placement", () => {
    it("starts only on a machine the project's list names, any when it names none", async () => {
      const github = new FakeGithub();
      github.add(REPO, 1);
      const issues = () => [ready(REPO, 1)];
      const omarchy = machine(github, issues, { placement: () => ["distilo-1"] });
      await omarchy.queue.tick();
      expect(omarchy.tmux.started).toHaveLength(0);
      expect(omarchy.queue.status().waiting).toMatchObject([{ why: "Placed on distilo-1" }]);
      const distilo = machine(github, issues, { name: "distilo-1.tail.ts.net", placement: () => ["distilo-1"] });
      await distilo.queue.tick();
      expect(distilo.tmux.started).toHaveLength(1);
    });

    it("leaves a project engage holds to engage, even where another machine has a checkout of it", async () => {
      const github = new FakeGithub();
      github.add("client/app", 1);
      const issues = () => [ready("client/app", 1)];
      const omarchy = machine(github, issues, { keptBy: (repo) => (repo === "client/app" ? "engage" : null) });
      await omarchy.queue.tick();
      expect(omarchy.tmux.started).toHaveLength(0);
      expect(github.comments).toHaveLength(0);
      expect(omarchy.queue.status().waiting).toMatchObject([{ why: "Runs only on engage" }]);
      // engage itself: no other keeper holds it.
      const engage = machine(github, issues, { name: "engage" });
      await engage.queue.tick();
      expect(engage.tmux.started).toHaveLength(1);
    });
  });

  describe("a worker that disappears", () => {
    it("is put back once, then asks for help", async () => {
      const github = new FakeGithub();
      github.add(REPO, 4);
      const m = machine(github, () => [ready(REPO, 4)]);
      await m.queue.tick();
      expect(m.tmux.started).toHaveLength(1);

      // The window closes with the issue still open.
      m.tmux.windows.clear();
      await m.queue.tick();
      // Put back and, in the same sweep, taken again.
      expect(m.tmux.started).toHaveLength(2);
      expect(github.comments.some((c) => c.body.includes(RELEASE_MARK))).toBe(true);
      expect(m.queue.status().log.map((e) => e.what)).toContain("Put back: its worker disappeared, trying once more");

      m.tmux.windows.clear();
      await m.queue.tick();
      const labels = github.get(REPO, 4).labels;
      expect(labels.has("needs-help")).toBe(true);
      expect(labels.has("in-progress")).toBe(false);
      expect(m.tmux.started).toHaveLength(2);
      expect(github.comments.at(-1)!.body).toMatch(/disappeared twice/);
      expect(m.queue.status().workers).toEqual([]);
    });

    it("is left alone when its issue already waits on a person", async () => {
      const github = new FakeGithub();
      github.add(REPO, 4);
      const m = machine(github, () => [ready(REPO, 4)]);
      await m.queue.tick();
      github.get(REPO, 4).labels.add("needs-help");
      m.tmux.windows.clear();
      await m.queue.tick();
      // Released with in-progress off; needs-help alone keeps it out of the queue.
      expect(github.get(REPO, 4).labels.has("in-progress")).toBe(false);
      expect(github.get(REPO, 4).labels.has("needs-help")).toBe(true);
      expect(m.queue.status().workers).toEqual([]);
      expect(m.tmux.started).toHaveLength(1);
    });

    it("is not taken for gone when tmux cannot be asked", async () => {
      const github = new FakeGithub();
      github.add(REPO, 4);
      const m = machine(github, () => [ready(REPO, 4)]);
      await m.queue.tick();
      const broken = machine(github, () => [ready(REPO, 4)], {
        file: m.store.file,
        tmux: async () => ({ ok: false, stdout: "server exited unexpectedly" }),
      });
      await broken.queue.tick();
      expect(broken.queue.status().workers).toHaveLength(1);
      expect(github.get(REPO, 4).labels.has("in-progress")).toBe(true);
    });
  });

  it("ends a worker whose issue closed, and removes its worktree and branch", async () => {
    const github = new FakeGithub();
    github.add(REPO, 5);
    const m = machine(github, () => [ready(REPO, 5)]);
    await m.queue.tick();
    github.get(REPO, 5).open = false;
    await m.queue.tick();
    expect(m.tmux.killed).toEqual(["@1"]);
    expect(m.git).toEqual([
      ["/home/leo/Projects/scratch", "worktree", "remove", "--force", ".worktree/5"],
      ["/home/leo/Projects/scratch", "branch", "-D", "task/5"],
    ]);
    expect(m.queue.status().workers).toEqual([]);
  });

  describe("two machines racing for one issue", () => {
    it("starts one worker: the earlier claim wins and the other deletes its own", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      const issues = () => [ready(REPO, 6)];
      const a = machine(github, issues, { name: "omarchy" });
      const b = machine(github, issues, { name: "distilo-1" });
      // Both read the issue before either has labelled it, and neither sees
      // the other's comment until the settle.
      github.lagging = true;
      await Promise.all([a.queue.tick(), b.queue.tick()]);
      expect(a.tmux.started.length + b.tmux.started.length).toBe(1);
      expect(a.tmux.started).toHaveLength(1);
      const claims = github.comments.filter((c) => c.body.includes("claude-mux:claim"));
      expect(claims).toHaveLength(1);
      expect(claims[0].body).toContain("id-omarchy");
      expect(b.queue.status().log[0].what).toBe("Another machine claimed it (id-omarchy)");
      expect(b.queue.status().waiting).toMatchObject([{ number: 6, why: "A worker owns it" }]);
      // The loser leaves the winner's label on.
      expect(github.get(REPO, 6).labels.has("in-progress")).toBe(true);
    });

    it("lets a claim from before the issue was put back lose to a fresh one", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      const issues = () => [ready(REPO, 6)];
      const a = machine(github, issues, { name: "omarchy" });
      await a.queue.tick();
      a.tmux.windows.clear();
      // omarchy puts it back and takes it again; its new claim, after the release, is the one that counts.
      await a.queue.tick();
      expect(a.tmux.started).toHaveLength(2);
      expect(a.queue.status().workers).toHaveLength(1);
    });

    it("takes an issue whose old claim was never released once that claim's machine is gone", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      // A claim from a day ago by a machine that is gone, and no release after it.
      github.comments.push({ repo: REPO, number: 6, id: 1, body: "<!-- claude-mux:claim id-gone -->", at: github.clock - 86_400_000 });
      const a = machine(github, () => [ready(REPO, 6)], { machineGone: (id) => id === "id-gone" });
      await a.queue.tick();
      expect(a.tmux.started).toHaveLength(1);
    });

    it("lets an old claim stand while its machine is still there, whatever its age", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      // distilo-1 claimed it a day ago and its label failed or was taken off: it may still run a worker.
      github.comments.push({ repo: REPO, number: 6, id: 1, body: "<!-- claude-mux:claim id-distilo-1 -->", at: github.clock - 86_400_000 });
      const a = machine(github, () => [ready(REPO, 6)]);
      await a.queue.tick();
      expect(a.tmux.started).toHaveLength(0);
    });

    it("lets its own left-over claim lapse, since it knows it runs no worker on the issue", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      github.comments.push({ repo: REPO, number: 6, id: 1, body: "<!-- claude-mux:claim id-omarchy -->", at: github.clock - 86_400_000 });
      const a = machine(github, () => [ready(REPO, 6)]);
      await a.queue.tick();
      expect(a.tmux.started).toHaveLength(1);
    });

    it("leaves the label on and starts nothing when its claim cannot be read back, since a release could void the winner's", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      github.failMarkers = 3;
      const a = machine(github, () => [ready(REPO, 6)]);
      await a.queue.tick();
      expect(a.tmux.started).toHaveLength(0);
      expect(github.comments).toEqual([]);
      expect(github.get(REPO, 6).labels.has("in-progress")).toBe(true);
      expect(a.queue.status().waiting).toMatchObject([{ why: "Could not read its claims" }]);
    });

    it("reads the claims again when the first read fails", async () => {
      const github = new FakeGithub();
      github.add(REPO, 6);
      github.failMarkers = 1;
      const a = machine(github, () => [ready(REPO, 6)]);
      await a.queue.tick();
      expect(a.tmux.started).toHaveLength(1);
    });
  });

  it("does not take another window for its worker after tmux restarts and the ids start again", async () => {
    const github = new FakeGithub();
    github.add(REPO, 5);
    const m = machine(github, () => [ready(REPO, 5)]);
    await m.queue.tick();
    const tmux = m.tmux.runner();
    await tmux(["restart"]);
    // Someone's shell gets @1 on the new server.
    m.tmux.windows.add("5151 @1 zsh");
    github.get(REPO, 5).open = false;
    await m.queue.tick();
    expect(m.tmux.killed).toEqual([]);
    expect(m.queue.status().workers).toEqual([]);
  });

  it("starts over the retry count for a worker that asked for help", async () => {
    const github = new FakeGithub();
    github.add(REPO, 4);
    const m = machine(github, () => [ready(REPO, 4)]);
    await m.queue.tick();
    m.tmux.windows.clear();
    await m.queue.tick(); // put back once, started again
    github.get(REPO, 4).labels.add("needs-help");
    m.tmux.windows.clear();
    await m.queue.tick();
    expect(m.store.file.retried).toEqual([]);
  });
});

describe("placement preferences", () => {
  it("reads machine lists from the preferences", () => {
    expect(nameList(["Omarchy.tail1234.ts.net", "distilo-1", "omarchy", ""])).toEqual(["omarchy", "distilo-1"]);
    expect(nameList([])).toBeNull();
    expect(nameList("omarchy")).toBeNull();
    expect(exclusiveList(undefined)).toEqual(["engage"]);
    expect(exclusiveList([])).toEqual([]);
  });
});


function memoryHistory(): HistoryStore & { runs: WorkerRun[] } {
  const h = {
    runs: [] as WorkerRun[],
    load: () => structuredClone(h.runs),
    append: (run: WorkerRun) => void h.runs.push(run),
  };
  return h;
}

describe("the history (#201)", () => {
  const T0 = Date.parse("2026-11-07T12:00:00Z");

  function clocked(github: FakeGithub, issues: () => ReadyIssue[], extra: Parameters<typeof machine>[2] = {}) {
    let t = T0;
    const history = memoryHistory();
    const m = machine(github, issues, { now: () => t, history, ...extra });
    return { ...m, history, advance: (ms: number) => (t += ms) };
  }

  it("keeps a merged run with how long it waited, its peak memory and its spend", async () => {
    const github = new FakeGithub();
    github.add(REPO, 5);
    const live: LiveWorker[] = [];
    let mem = 1.1;
    const m = clocked(github, () => [ready(REPO, 5)], {
      file: { settings: { ...DEFAULT_SETTINGS, enabled: false } },
      liveWorkers: () => live,
      measure: async (pids) => new Map(pids.map((p) => [p, mem])),
      spend: async () => 2.5,
    });
    await m.queue.tick(); // seen, but off
    expect(m.queue.status().waiting).toMatchObject([{ number: 5, kind: "off", since: T0 }]);
    m.advance(10 * 60_000);
    m.queue.update({ enabled: true });
    await m.queue.tick();
    live.push({ issue: 5, cwd: "/home/leo/Projects/scratch/.worktree/5", id: "sess-5", pid: 900, transcript: "/t/5.jsonl" });
    mem = 2.3;
    await m.queue.tick();
    mem = 1.4;
    await m.queue.tick();
    expect(m.queue.status().workers).toMatchObject([{ number: 5, sessionId: "sess-5", memGiB: 1.4, peakGiB: 2.3, spendUsd: 2.5 }]);

    m.advance(30 * 60_000);
    github.get(REPO, 5).open = false;
    await m.queue.tick();
    expect(m.history.runs).toEqual([
      expect.objectContaining({
        number: 5,
        result: "merged",
        queuedAt: T0,
        startedAt: T0 + 10 * 60_000,
        endedAt: T0 + 40 * 60_000,
        peakGiB: 2.3,
        spendUsd: 2.5,
        machine: "omarchy",
      }),
    ]);
    expect(m.queue.history(7)).toHaveLength(1);
  });

  it("counts a worker that vanished as lost, and one that asked for help as help", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    github.add(REPO, 2);
    const m = clocked(github, () => [ready(REPO, 1), ready(REPO, 2)]);
    await m.queue.tick();
    github.get(REPO, 2).labels.add("needs-help");
    await m.queue.tick();
    expect(m.queue.status().workers.find((w) => w.number === 2)?.wants).toBe(true);
    m.advance(60 * 60_000);
    m.tmux.windows.clear();
    await m.queue.tick();
    // #1 went back and started again: its first run is no finished run, and the retry's wait starts now.
    expect(m.history.runs.map((r) => [r.number, r.result])).toEqual([[2, "help"]]);
    expect(m.queue.status().workers.find((w) => w.number === 1)?.queuedAt).toBe(T0 + 60 * 60_000);
    m.tmux.windows.clear();
    await m.queue.tick();
    expect(m.history.runs.map((r) => [r.number, r.result]).sort()).toEqual([
      [1, "lost"],
      [2, "help"],
    ]);
  });

  it("stops nothing when tmux cannot close the worker's window", async () => {
    const github = new FakeGithub();
    github.add(REPO, 4);
    const m = clocked(github, () => [ready(REPO, 4)]);
    await m.queue.tick();
    const runner = m.tmux.runner();
    (m.queue as unknown as { deps: QueueDeps }).deps.tmux = async (args) =>
      args[0] === "kill-window" ? { ok: false, stdout: "" } : runner(args);
    expect(await m.queue.stop(REPO, 4)).toMatch(/could not close/);
    expect(m.queue.status().workers).toHaveLength(1);
    expect(github.get(REPO, 4).labels.has("hold")).toBe(false);
  });

  it("stops a worker by hand: its window killed, the issue on hold and out of the queue", async () => {
    const github = new FakeGithub();
    github.add(REPO, 3);
    const m = clocked(github, () => [ready(REPO, 3)]);
    await m.queue.tick();
    expect(await m.queue.stop(REPO, 3)).toBeNull();
    expect(m.tmux.killed).toEqual(["@1"]);
    const labels = github.get(REPO, 3).labels;
    expect(labels.has("hold")).toBe(true);
    expect(labels.has("in-progress")).toBe(false);
    expect(github.comments.at(-1)!.body).toContain(RELEASE_MARK);
    expect(m.history.runs).toMatchObject([{ number: 3, result: "stopped" }]);
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(1);
    expect(m.queue.status().waiting).toMatchObject([{ number: 3, why: "On hold", kind: "taken" }]);
    expect(await m.queue.stop(REPO, 3)).toMatch(/No worker/);
  });

  it("says what each queued issue waits for", async () => {
    const github = new FakeGithub();
    for (const n of [1, 2, 3]) github.add(REPO, n);
    const m = clocked(github, () => [ready(REPO, 1), ready(REPO, 2, { blockedBy: 1 }), ready(REPO, 3)], {
      file: { settings: { ...DEFAULT_SETTINGS, enabled: true, limit: 1 } },
    });
    await m.queue.tick();
    expect(m.queue.status().waiting.map((w) => w.kind)).toEqual(["blocked", "slot"]);
  });

  it("lists a daemon's worker beside the queue's own, with its memory", async () => {
    const github = new FakeGithub();
    const m = clocked(github, () => [], {
      liveWorkers: () => [{ issue: 50, cwd: "/elsewhere", id: "d", pid: 7 }],
      measure: async () => new Map([[7, 1.2]]),
    });
    await m.queue.tick();
    expect(m.queue.status().others).toEqual([{ issue: 50, cwd: "/elsewhere", sessionId: "d", memGiB: 1.2 }]);
  });
});

describe("sumTrees", () => {
  it("adds up each root's descendants, in GiB", () => {
    const rows = [
      [1, 0, 100],
      [10, 1, 1048576],
      [11, 10, 524288],
      [12, 11, 524288],
      [20, 1, 1024],
    ].map(([pid, ppid, rssKb]) => ({ pid, ppid, rssKb, args: "x" }));
    const out = sumTrees(rows, [10, 20, 99]);
    expect(out.get(10)).toBe(2);
    expect(out.get(20)).toBeCloseTo(1 / 1024);
    expect(out.has(99)).toBe(false);
  });
});

describe("what review found in the queue (#213)", () => {
  const claims = (github: FakeGithub) => github.comments.filter((c) => c.body.includes("claude-mux:claim"));
  const releases = (github: FakeGithub) => github.comments.filter((c) => c.body.includes(RELEASE_MARK));

  it("claims nothing when GitHub's updated_at is not the copy readiness was judged on", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    // The poller judged an older copy; a stranger's comment moved updated_at since.
    const m = machine(github, () => [ready(REPO, 1, { updatedAt: "2026-11-07T10:00:00Z" })]);
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(github.comments).toEqual([]);
    expect(m.queue.status().waiting[0].why).toMatch(/Changed since/);
  });

  it("claims nothing where the project's root is no checkout of it, so claude never runs in $HOME", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    const m = machine(github, () => [ready(REPO, 1)], { checkout: async () => "No checkout here: /gone is missing" });
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(github.comments).toEqual([]);
    expect(m.queue.status().waiting[0]).toMatchObject({ why: "No checkout here: /gone is missing", kind: "placed" });
  });

  it("asks for help after a few failed starts instead of claiming and releasing every minute", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    const real = new FakeTmux().runner();
    const m = machine(github, () => [ready(REPO, 1)], {
      tmux: async (args) => (args[0] === "new-window" || args[0] === "new-session" ? { ok: false, stdout: "" } : real(args)),
    });
    for (let i = 0; i < START_ATTEMPTS + 2; i++) await m.queue.tick();
    expect(claims(github)).toHaveLength(START_ATTEMPTS);
    expect(releases(github)).toHaveLength(START_ATTEMPTS);
    const labels = github.get(REPO, 1).labels;
    expect(labels.has("needs-help")).toBe(true);
    expect(labels.has("in-progress")).toBe(false);
    expect(m.store.file.failedStarts).toEqual({});
  });

  it("treats a failed in-progress label like a failed comment: its claim deleted and nothing started", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    github.failLabels = 1;
    const m = machine(github, () => [ready(REPO, 1)]);
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(github.comments).toEqual([]);
    expect(m.queue.status().waiting[0].why).toMatch(/Could not label it/);
  });

  it("counts every worker started in the last ten minutes against free memory, not just this sweep's", () => {
    const github = new FakeGithub();
    const m = machine(github, () => [], {
      memory: () => ({ availableGiB: 3, pressure: 0 }),
      file: {
        workers: [
          {
            repo: REPO,
            number: 1,
            title: "",
            url: "",
            root: "/p",
            window: "@1",
            server: "4242",
            name: "mw-1",
            target: "queue-scratch:mw-1",
            startedAt: Date.now() - 5 * 60_000,
          },
        ],
      },
    });
    expect(m.queue.room()).toMatch(/1\.6 GiB free, under 2\.5 GiB/);
  });

  it("claims nothing for a project no longer starting sessions, nor for an issue no longer ready-for-agent", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    github.add(REPO, 2, []);
    const off = machine(github, () => [ready(REPO, 1)], { wanted: () => false });
    await off.queue.tick();
    expect(github.comments).toEqual([]);
    const m = machine(github, () => [ready(REPO, 2)]);
    await m.queue.tick();
    expect(github.comments).toEqual([]);
    expect(m.tmux.started).toHaveLength(0);
  });

  it("kills no window by its bare id when tmux could not list them", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    const m = machine(github, () => [ready(REPO, 1)]);
    await m.queue.tick();
    github.get(REPO, 1).open = false;
    const killed: string[][] = [];
    const broken = machine(github, () => [], {
      file: m.store.file,
      tmux: async (args) => {
        if (args[0] === "kill-window") killed.push(args);
        return { ok: false, stdout: "server exited unexpectedly" };
      },
    });
    await broken.queue.tick();
    expect(killed).toEqual([]);
  });

  it("keeps a worker whose window a person renamed", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    const m = machine(github, () => [ready(REPO, 1)]);
    await m.queue.tick();
    const [line] = [...m.tmux.windows];
    m.tmux.windows = new Set([line.replace(/ \S+$/, " my-renamed-window")]);
    await m.queue.tick();
    expect(m.queue.status().workers).toHaveLength(1);
    expect(releases(github)).toEqual([]);
    expect(github.get(REPO, 1).labels.has("in-progress")).toBe(true);
  });

  it("starts nothing on a lagging comment list until two reads agree on the winner", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    // distilo-1 claimed first, but its comment is missing from this machine's first read.
    github.comments.push({ repo: REPO, number: 1, id: 1, body: "<!-- claude-mux:claim id-distilo-1 -->", at: github.clock });
    github.hideReads.set(1, 1);
    const m = machine(github, () => [ready(REPO, 1)]);
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(0);
    expect(claims(github).map((c) => c.id)).toEqual([1]);
  });

  it("releases the claim of a worker that ended asking for help, so a later claim can win", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    const m = machine(github, () => [ready(REPO, 1)]);
    await m.queue.tick();
    github.get(REPO, 1).labels.add("needs-help");
    m.tmux.windows.clear();
    await m.queue.tick();
    expect(releases(github)).toHaveLength(1);
    // in-progress off: needs-help keeps it out of the queue until the person clears it, and then nothing does.
    expect(github.get(REPO, 1).labels.has("in-progress")).toBe(false);
    github.get(REPO, 1).labels.delete("needs-help");
    await m.queue.tick();
    expect(m.tmux.started).toHaveLength(2);
  });

  it("forgets failed starts of an issue that left the queue", async () => {
    const github = new FakeGithub();
    github.add(REPO, 1);
    let issues = [ready(REPO, 1)];
    const real = new FakeTmux().runner();
    const m = machine(github, () => issues, {
      tmux: async (args) => (args[0] === "new-window" || args[0] === "new-session" ? { ok: false, stdout: "" } : real(args)),
    });
    await m.queue.tick();
    expect(m.store.file.failedStarts).toEqual({ [`${REPO}#1`]: 1 });
    issues = [];
    await m.queue.tick();
    expect(m.store.file.failedStarts).toEqual({});
  });
});

describe("checkoutProblem", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  it("passes only a checkout of the repo at its root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkout-"));
    try {
      expect(await checkoutProblem(join(dir, "missing"), "o/r")).toMatch(/missing/);
      const plain = join(dir, "plain");
      mkdirSync(plain);
      expect(await checkoutProblem(plain, "o/r")).toMatch(/not a git repository/);
      const repo = join(dir, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q");
      git(repo, "remote", "add", "origin", "git@github.com:O/R.git");
      expect(await checkoutProblem(repo, "o/r")).toBeNull();
      expect(await checkoutProblem(repo, "o/other")).toMatch(/not a checkout of o\/other/);
      // A project rooted in a subfolder of its repo, and a clone whose origin is a fork.
      mkdirSync(join(repo, "sub"));
      expect(await checkoutProblem(join(repo, "sub"), "o/r")).toBeNull();
      git(repo, "remote", "rename", "origin", "upstream");
      git(repo, "remote", "add", "origin", "https://github.com/fork/r.git");
      expect(await checkoutProblem(repo, "o/r")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
