import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  ReleaseRule,
  SETTLE_MS,
  PUBLISH_DEADLINE_MS,
  SELF_DEADLINE_MS,
  RETRY_MS,
  RECONNECT_MS,
  STALE_READ_MS,
  TRANSIENT_TRIES,
  emptyReleaseFile,
  gateEnv,
  isDocsPath,
  isTransientFailure,
  releaseExcludeList,
  scrubOutput,
  takesPart,
  type GateResult,
  type ReleaseDeps,
  type ReleaseFile,
  type ReleaseMachine,
  type ReleaseStore,
} from "../../src/server/release.js";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const A = "a".repeat(40);
const B = "b".repeat(40);
const BUMP = "c".repeat(40);

function memoryStore(): ReleaseStore & { file: ReleaseFile } {
  return {
    file: emptyReleaseFile(),
    load() {
      return JSON.parse(JSON.stringify(this.file)) as ReleaseFile;
    },
    save(file) {
      this.file = JSON.parse(JSON.stringify(file)) as ReleaseFile;
    },
  };
}

/** Everything the rule reaches, faked, with what it was asked kept. */
class World {
  now = T0;
  store = memoryStore();
  head = A;
  held = false;
  version = "1.0.0";
  /** What changed since the last tag, by sha. */
  changes = new Map<string, { lastTag: string | null; tagged: boolean; files: string[] } | null>();
  gates = new Map<string, GateResult>();
  gated: string[] = [];
  tagged: string[] = [];
  issues: { title: string; body: string }[] = [];
  npm = new Set<string>();
  machines: ReleaseMachine[] = [
    { id: "omarchy-id", name: "omarchy", self: true, online: true },
    { id: "distilo-id", name: "distilo-1", self: false, online: true },
    { id: "beta-id", name: "beta", self: false, online: true },
  ];
  /** Each machine's version as its health check answers. */
  versions = new Map<string, string | null>([
    ["omarchy-id", "1.0.0"],
    ["distilo-id", "1.0.0"],
    ["beta-id", "1.0.0"],
  ]);
  selfStarts = 0;
  selfJob: { startedAt: number; state: "running" | "ok" | "failed"; line: string } | null = null;
  remoteUpdates: string[] = [];
  remoteFails = new Set<string>();
  /** When set, tagging fails with this. */
  tagError: string | null = null;
  /** When set, tagging finds this tag already on the head. */
  tagExisting: string | null = null;
  /** When GitHub was last read; follows the clock unless set. */
  readAt: number | null = null;
  /** Issues still open, by number, and the comments made on them. */
  openIssues = new Set<number>();
  comments: { issue: number; body: string }[] = [];
  pushedTags: { sha: string; version: string }[] = [];
  /** The version each update was asked for. */
  askedVersions: string[] = [];
  /** Health reads a remote machine answers with its old version after updating, before the new one. */
  slowRestarts = new Map<string, number>();

  deps(): ReleaseDeps {
    return {
      store: this.store,
      now: () => this.now,
      github: () => ({ head: this.head, held: this.held, readAt: this.readAt ?? this.now }),
      repo: {
        changes: async (sha) => (this.changes.has(sha) ? this.changes.get(sha)! : { lastTag: `v${this.version}`, tagged: false, files: ["src/x.ts"] }),
        gate: async (sha) => {
          this.gated.push(sha);
          return this.gates.get(sha) ?? { ok: true };
        },
        tag: async (sha) => {
          this.tagged.push(sha);
          if (this.tagExisting) return { existing: this.tagExisting };
          if (this.tagError) return this.tagError;
          const [maj, min, patch] = this.version.split(".").map(Number);
          this.version = `${maj}.${min}.${patch + 1}`;
          return { version: this.version };
        },
        pushTag: async (sha, version) => {
          this.pushedTags.push({ sha, version });
          return null;
        },
      },
      fileIssue: async (title, body) => {
        this.issues.push({ title, body });
        this.openIssues.add(300 + this.issues.length);
        return 300 + this.issues.length;
      },
      commentIssue: async (issue, body) => {
        if (!this.openIssues.has(issue)) return false;
        this.comments.push({ issue, body });
        return true;
      },
      published: async (v) => this.npm.has(v),
      machines: () => this.machines,
      updateSelf: (version) => {
        this.askedVersions.push(version);
        this.selfStarts++;
        this.selfJob = { startedAt: this.now, state: "running", line: "" };
        return this.now;
      },
      selfJob: () => this.selfJob,
      updateRemote: async (m, version) => {
        this.askedVersions.push(version);
        this.remoteUpdates.push(m.name);
        if (this.remoteFails.has(m.id)) return { ok: false, line: "npm ERR! boom" };
        if (!this.slowRestarts.has(m.id)) this.versions.set(m.id, version);
        return { ok: true, line: "Updated" };
      },
      health: async (m) => {
        const slow = this.slowRestarts.get(m.id);
        if (slow !== undefined) {
          if (slow > 0) this.slowRestarts.set(m.id, slow - 1);
          else {
            this.slowRestarts.delete(m.id);
            this.versions.set(m.id, this.version);
          }
        }
        return this.versions.get(m.id) ?? null;
      },
    };
  }

  rule(): ReleaseRule {
    return new ReleaseRule(this.deps());
  }

  /** The update this machine started finishing, and its server coming back on the new version. */
  selfComesBack(): void {
    this.selfJob = { ...this.selfJob!, state: "ok", line: "Updated" };
    this.versions.set("omarchy-id", this.version);
  }
}

async function ticks(rule: ReleaseRule, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await rule.tick();
}

describe("release rule", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  it("gates, waits for the merges to settle, tags, waits for npm, and rolls out omarchy first", async () => {
    const rule = w.rule();
    await rule.tick();
    expect(w.gated).toEqual([A]);
    expect(rule.state().gate).toMatchObject({ sha: A, state: "passed" });

    // Not before ten minutes after the head last moved.
    w.now += SETTLE_MS - 1;
    await rule.tick();
    expect(w.tagged).toEqual([]);
    w.now += 1;
    await rule.tick();
    expect(w.tagged).toEqual([A]);
    expect(rule.state().release).toMatchObject({ version: "1.0.1", state: "publishing" });

    // Nothing is updated before npm has the version.
    await rule.tick();
    expect(w.selfStarts).toBe(0);
    w.npm.add("1.0.1");
    await rule.tick();
    expect(w.selfStarts).toBe(1);
    expect(w.remoteUpdates).toEqual([]);

    // Waiting on this machine's own update; the others wait their turn.
    await ticks(rule, 2);
    expect(w.remoteUpdates).toEqual([]);
    w.selfComesBack();
    await rule.tick();
    expect(rule.state().release!.attempts[0]).toMatchObject({ name: "omarchy", state: "ok" });
    await ticks(rule, 3);
    expect(w.remoteUpdates).toEqual(["beta", "distilo-1"]);
    expect(rule.state().release).toMatchObject({ state: "done" });
    expect(w.issues).toEqual([]);
    expect(w.selfStarts).toBe(1);
  });

  it("waits ten minutes from the last merge, not the first", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS - 60_000;
    w.head = B;
    await rule.tick();
    expect(w.gated).toEqual([A, B]);
    w.now += 60_000;
    await rule.tick();
    expect(w.tagged).toEqual([]);
    w.now += SETTLE_MS;
    await rule.tick();
    expect(w.tagged).toEqual([B]);
  });

  it("releases nothing for commits that touch only docs, nor for the bump commit itself", async () => {
    w.changes.set(A, { lastTag: "v1.0.0", tagged: false, files: ["README.md", "docs/adr/0005.md"] });
    w.changes.set(BUMP, { lastTag: "v1.0.0", tagged: true, files: [] });
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    expect(w.gated).toEqual([]);
    expect(w.tagged).toEqual([]);
    expect(rule.state().log[0].reason).toMatch(/only docs/);

    w.head = BUMP;
    w.now += SETTLE_MS;
    await ticks(rule, 2);
    expect(w.gated).toEqual([]);
    expect(w.tagged).toEqual([]);
  });

  it("files an issue for a failed gate and waits for a new commit", async () => {
    w.gates.set(A, { ok: false, step: "test", output: "FAIL tests/x.test.ts\n1 failed" });
    const rule = w.rule();
    await rule.tick();
    expect(rule.state().gate).toMatchObject({ sha: A, state: "failed", issue: 301 });
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0].title).toBe("Release gate failed on aaaaaaa: test");
    expect(w.issues[0].body).toContain("1 failed");

    w.now += SETTLE_MS * 3;
    await ticks(rule, 3);
    expect(w.gated).toEqual([A]);
    expect(w.tagged).toEqual([]);
    expect(w.issues).toHaveLength(1);

    w.head = B;
    await rule.tick();
    expect(w.gated).toEqual([A, B]);
    w.now += SETTLE_MS;
    await rule.tick();
    expect(w.tagged).toEqual([B]);
  });

  it("does nothing at all while a release-hold issue is open, and goes on once it closes", async () => {
    w.held = true;
    const rule = w.rule();
    w.now += SETTLE_MS;
    await ticks(rule, 3);
    expect(w.gated).toEqual([]);
    expect(rule.state().log.filter((l) => /release-hold/.test(l.reason))).toHaveLength(1);

    w.held = false;
    await rule.tick();
    expect(w.gated).toEqual([A]);
    // The head was first seen under the hold; its ten minutes still count from then.
    w.now += SETTLE_MS;
    w.held = true;
    await rule.tick();
    expect(w.tagged).toEqual([]);
    w.held = false;
    await rule.tick();
    expect(w.tagged).toEqual([A]);

    // A hold opened during the rollout stops the next machine from starting.
    w.npm.add("1.0.1");
    await rule.tick();
    w.selfComesBack();
    await rule.tick();
    w.held = true;
    await ticks(rule, 3);
    expect(w.remoteUpdates).toEqual([]);
    w.held = false;
    await ticks(rule, 3);
    expect(w.remoteUpdates).toEqual(["beta", "distilo-1"]);
  });

  it("stops the rollout at a failed machine, files an issue, and rolls nothing back", async () => {
    w.remoteFails.add("beta-id");
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    w.selfComesBack();
    await ticks(rule, 5);
    const release = rule.state().release!;
    expect(release.state).toBe("stopped");
    expect(release.attempts.map((a) => [a.name, a.state])).toEqual([
      ["omarchy", "ok"],
      ["beta", "failed"],
      ["distilo-1", "skipped"],
    ]);
    expect(w.remoteUpdates).toEqual(["beta"]);
    expect(w.issues.map((i) => i.title)).toEqual(["Rollout of v1.0.1 stopped"]);
    expect(w.issues[0].body).toContain("Already updated: omarchy. Nothing was rolled back.");
    expect(w.issues[0].body).toContain("npm ERR! boom");
    // One attempt per version: later ticks try nothing more.
    await ticks(rule, 3);
    expect(w.remoteUpdates).toEqual(["beta"]);
    expect(w.selfStarts).toBe(1);
  });

  it("stops the rollout when omarchy does not come back healthy on the new version", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    // The update reports success, but the server still answers the old version.
    w.selfJob = { ...w.selfJob!, state: "ok" };
    await rule.tick();
    expect(rule.state().release!.state).toBe("rolling-out");
    w.now += SELF_DEADLINE_MS + 1;
    await rule.tick();
    expect(rule.state().release!.state).toBe("stopped");
    expect(rule.state().release!.attempts[0]).toMatchObject({ state: "failed" });
    expect(rule.state().release!.attempts[0].reason).toMatch(/still on v1\.0\.0/);
    expect(w.remoteUpdates).toEqual([]);
  });

  it("stops the rollout when omarchy's own update fails", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    w.selfJob = { ...w.selfJob!, state: "failed", line: "EACCES" };
    await rule.tick();
    expect(rule.state().release!.reason).toBe("omarchy: EACCES");
    expect(w.remoteUpdates).toEqual([]);
  });

  it("picks up after its own server restarts mid-update, without starting the update again", async () => {
    let rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    expect(w.selfStarts).toBe(1);

    // The update restarts this server: a new rule reads the file back.
    w.selfComesBack();
    rule = w.rule();
    await rule.tick();
    expect(rule.state().release!.attempts[0]).toMatchObject({ state: "ok" });
    await ticks(rule, 3);
    expect(rule.state().release!.state).toBe("done");
    expect(w.selfStarts).toBe(1);
  });

  it("judges a remote attempt cut off by a restart by where the machine is now", async () => {
    w.store.file = {
      ...emptyReleaseFile(),
      head: { sha: A, seenAt: T0 },
      gate: { sha: A, state: "passed", reason: "", at: T0 },
      release: {
        sha: A,
        version: "1.0.1",
        taggedAt: T0,
        state: "rolling-out",
        reason: "",
        attempts: [
          { machine: "omarchy-id", name: "omarchy", self: true, state: "ok", reason: "" },
          { machine: "beta-id", name: "beta", self: false, state: "updating", reason: "", startedAt: T0 },
          { machine: "distilo-id", name: "distilo-1", self: false, state: "queued", reason: "" },
        ],
      },
    };
    w.versions.set("beta-id", "1.0.1");
    w.version = "1.0.1";
    const rule = w.rule();
    await ticks(rule, 3);
    expect(w.remoteUpdates).toEqual(["distilo-1"]);
    expect(rule.state().release!.state).toBe("done");
  });

  it("passes over a machine still offline a while after its turn came, and names it at the end", async () => {
    w.machines[1].online = false;
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    w.selfComesBack();
    await ticks(rule, 4);
    expect(rule.state().release!.attempts[2]).toMatchObject({ name: "distilo-1", state: "queued" });
    w.now += RECONNECT_MS;
    await ticks(rule, 2);
    expect(rule.state().release!.attempts.map((a) => [a.name, a.state])).toEqual([
      ["omarchy", "ok"],
      ["beta", "ok"],
      ["distilo-1", "skipped"],
    ]);
    expect(rule.state().release).toMatchObject({ state: "done", reason: "v1.0.1 is on omarchy, beta; not updated: distilo-1" });
    expect(rule.state().log[0].reason).toBe("v1.0.1 is on omarchy, beta; not updated: distilo-1");
  });

  it("waits for the fleet to reconnect after this machine's own restart before calling a peer offline", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    // This server comes back on the new version, and its links to the fleet start offline.
    w.selfComesBack();
    for (const m of w.machines) if (!m.self) m.online = false;
    const after = new ReleaseRule(w.deps());
    await ticks(after, 3);
    w.now += 30_000;
    for (const m of w.machines) m.online = true;
    await ticks(after, 4);
    expect(after.state().release!.attempts.map((a) => [a.name, a.state])).toEqual([
      ["omarchy", "ok"],
      ["beta", "ok"],
      ["distilo-1", "ok"],
    ]);
    expect(after.state().release).toMatchObject({ state: "done", reason: "v1.0.1 is on omarchy, beta, distilo-1" });
  });

  it("asks every machine for the version it rolls out, and gives one still restarting a while to answer on it", async () => {
    w.slowRestarts.set("beta-id", 2);
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.npm.add("1.0.1");
    await rule.tick();
    w.selfComesBack();
    await ticks(rule, 6);
    expect(w.askedVersions).toEqual(["1.0.1", "1.0.1", "1.0.1"]);
    expect(rule.state().release!.attempts.map((a) => [a.name, a.state])).toEqual([
      ["omarchy", "ok"],
      ["beta", "ok"],
      ["distilo-1", "ok"],
    ]);
    expect(w.issues).toEqual([]);
  });

  it("does nothing on a read of GitHub that stopped coming, as it may miss a hold", async () => {
    const rule = w.rule();
    await rule.tick();
    expect(w.gated).toEqual([A]);
    w.readAt = w.now;
    w.now += SETTLE_MS;
    // A hold opened since would not show: the read is older than two polls.
    expect(w.now - w.readAt).toBeGreaterThan(STALE_READ_MS);
    await ticks(rule, 3);
    expect(w.tagged).toEqual([]);
    expect(rule.lastError).toMatch(/last read/);
    w.readAt = null;
    await rule.tick();
    expect(w.tagged).toEqual([A]);
  });

  it("stops at a head someone tagged by hand while it waited, and tags nothing again", async () => {
    w.tagExisting = "v1.0.1";
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    expect(rule.state().release).toBeNull();
    expect(rule.state().gate).toMatchObject({ sha: A, state: "skipped" });
    w.now += RETRY_MS * 3;
    await ticks(rule, 3);
    expect(w.tagged).toEqual([A]);
  });

  it("pushes the tag of a bump commit that reached main without it, rather than bumping again", async () => {
    w.changes.set(A, { lastTag: "v1.0.0", tagged: false, files: [], bump: "1.0.1" });
    const rule = w.rule();
    await rule.tick();
    expect(w.pushedTags).toEqual([{ sha: A, version: "1.0.1" }]);
    expect(w.gated).toEqual([]);
    expect(w.tagged).toEqual([]);
    expect(rule.state().release).toMatchObject({ sha: A, version: "1.0.1", state: "publishing" });
  });

  it("comments on the open gate-failure issue instead of filing one per merge, and files anew once it is closed", async () => {
    const failing = { ok: false as const, step: "test", output: "1 failed" };
    w.gates.set(A, failing);
    w.gates.set(B, failing);
    const rule = w.rule();
    await rule.tick();
    w.head = B;
    await rule.tick();
    expect(w.issues).toHaveLength(1);
    expect(w.comments).toMatchObject([{ issue: 301 }]);
    expect(rule.state().gate).toMatchObject({ sha: B, state: "failed", issue: 301 });
    expect(rule.state().log[0].reason).toMatch(/commented on #301/);

    w.openIssues.clear();
    w.head = "d".repeat(40);
    w.gates.set(w.head, failing);
    await rule.tick();
    expect(w.issues).toHaveLength(2);
  });

  it("retries an install or network failure before filing it", async () => {
    w.gates.set(A, { ok: false, step: "install", output: "error: ECONNRESET", transient: true });
    const rule = w.rule();
    for (let i = 1; i < TRANSIENT_TRIES; i++) {
      await rule.tick();
      expect(w.issues).toEqual([]);
      w.now += RETRY_MS;
    }
    await rule.tick();
    expect(w.gated).toHaveLength(TRANSIENT_TRIES);
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0].body).toContain(`${TRANSIENT_TRIES} times`);
  });

  it("gives up when npm never publishes the tag", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.now += PUBLISH_DEADLINE_MS + 1;
    await rule.tick();
    expect(rule.state().release!.state).toBe("stopped");
    expect(w.issues[0].title).toBe("Rollout of v1.0.1 stopped");
    expect(w.selfStarts).toBe(0);
  });

  it("lets a rollout finish before tagging the next merge", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.head = B;
    w.now += SETTLE_MS * 2;
    await ticks(rule, 3);
    expect(w.tagged).toEqual([A]);
    w.npm.add("1.0.1");
    await rule.tick();
    w.selfComesBack();
    await ticks(rule, 4);
    expect(rule.state().release!.state).toBe("done");
    await rule.tick();
    expect(w.gated).toEqual([A, B]);
    w.now += SETTLE_MS;
    await rule.tick();
    expect(w.tagged).toEqual([A, B]);
  });

  it("does not count a hold against npm's or a machine's deadline", async () => {
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await rule.tick();
    w.held = true;
    await rule.tick();
    w.now += PUBLISH_DEADLINE_MS * 2;
    await rule.tick();
    w.held = false;
    await rule.tick();
    expect(rule.state().release!.state).toBe("publishing");
    expect(w.issues).toEqual([]);
    w.npm.add("1.0.1");
    await rule.tick();
    expect(rule.state().release!.state).toBe("rolling-out");
  });

  it("tries a failed tag again after a while, saying so once", async () => {
    w.tagError = "the bump could not be pushed: auth";
    const rule = w.rule();
    await rule.tick();
    w.now += SETTLE_MS;
    await ticks(rule, 3);
    expect(w.tagged).toEqual([A]);
    w.now += RETRY_MS;
    await ticks(rule, 2);
    expect(w.tagged).toEqual([A, A]);
    expect(rule.state().log.filter((l) => /Could not tag/.test(l.reason))).toHaveLength(1);
    w.tagError = null;
    w.now += RETRY_MS;
    await rule.tick();
    expect(rule.state().release).toMatchObject({ version: "1.0.1" });
  });

  it("tries a gate the machinery could not run again later, without filing it", async () => {
    w.gates.set(A, { ok: false, step: "fetch", output: "could not fetch", transient: true });
    const rule = w.rule();
    await ticks(rule, 3);
    expect(w.gated).toEqual([A]);
    expect(w.issues).toEqual([]);
    w.gates.delete(A);
    w.now += RETRY_MS;
    await rule.tick();
    expect(w.gated).toEqual([A, A]);
    expect(rule.state().gate).toMatchObject({ sha: A, state: "passed" });
  });

  it("gives a remote machine cut off by a restart its while to come back", async () => {
    w.store.file = {
      ...emptyReleaseFile(),
      head: { sha: A, seenAt: T0 },
      gate: { sha: A, state: "passed", reason: "", at: T0 },
      release: {
        sha: A,
        version: "1.0.1",
        taggedAt: T0,
        state: "rolling-out",
        reason: "",
        attempts: [
          { machine: "omarchy-id", name: "omarchy", self: true, state: "ok", reason: "" },
          { machine: "beta-id", name: "beta", self: false, state: "updating", reason: "", startedAt: T0 },
        ],
      },
    };
    w.versions.set("beta-id", null);
    const rule = w.rule();
    await ticks(rule, 2);
    expect(rule.state().release!.state).toBe("rolling-out");
    w.versions.set("beta-id", "1.0.1");
    await rule.tick();
    expect(rule.state().release!.attempts[1]).toMatchObject({ state: "ok" });
    expect(w.remoteUpdates).toEqual([]);
  });

  it("acts on nothing before the first read of GitHub", async () => {
    const deps = w.deps();
    const rule = new ReleaseRule({ ...deps, github: () => null });
    await ticks(rule, 3);
    expect(w.gated).toEqual([]);
  });
});

describe("what takes part and what counts as docs", () => {
  it("runs the gate on an allowlist of variables, under a HOME and a tmux socket directory of its own", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "release-env-")), "env");
    const env = gateEnv(dir, {
      PATH: "/bin",
      LANG: "C.UTF-8",
      HOME: "/home/leo",
      TMUX: "/tmp/tmux-1000/default,1,0",
      TMUX_PANE: "%1",
      TMUX_TMPDIR: "/tmp",
      CLAUDECODE: "1",
      CLAUDE_MUX_PORT: "3456",
      MAESTRO_ISSUE: "203",
      GROQ_API_KEY: "gsk_secret",
      GH_TOKEN: "ghp_secret",
      NPM_TOKEN: "npm_secret",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(env).toEqual({ PATH: "/bin", LANG: "C.UTF-8", HOME: join(dir, "home"), TMUX_TMPDIR: join(dir, "tmux"), CI: "1" });
    rmSync(dirname(dir), { recursive: true, force: true });
  });

  it("scrubs and trims a failing gate's output before it goes into a public issue", () => {
    const env = { HOME: "/home/leo", GROQ_API_KEY: "plainsecretvalue123", PATH: "/bin" };
    const token = `ghp_${"x".repeat(36)}`;
    const noise = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = scrubOutput(`${noise}\nkey=plainsecretvalue123 at /home/leo/x\nauth ${token}\n${"y".repeat(9000)}\n\`\`\`end`, env);
    expect(out).not.toContain("plainsecretvalue123");
    expect(out).not.toContain(token);
    expect(out).not.toContain("/home/leo");
    expect(out).not.toContain("line 0\n");
    expect(out.length).toBeLessThan(6_100);
    expect(out).not.toContain("```");
  });

  it("counts an install or a network error as the machinery's, not the code's", () => {
    expect(isTransientFailure("install", "error: lockfile had changes")).toBe(true);
    expect(isTransientFailure("test", "getaddrinfo EAI_AGAIN registry.npmjs.org")).toBe(true);
    expect(isTransientFailure("test", "FAIL tests/x.test.ts")).toBe(false);
  });

  it("leaves out engage unless chosen, and any machine whose name cannot be told", () => {
    const exclude = releaseExcludeList(undefined);
    expect(takesPart("distilo-1", exclude)).toBe(true);
    expect(takesPart("engage", exclude)).toBe(false);
    expect(takesPart("Engage.tail1234.ts.net", exclude)).toBe(false);
    // Not because the queue keeps its projects: the release has a list of its own.
    expect(takesPart("engage", releaseExcludeList([]))).toBe(true);
    expect(takesPart("omarchy", releaseExcludeList(["omarchy"]))).toBe(false);
    expect(takesPart("", exclude)).toBe(false);
    expect(takesPart(undefined, exclude)).toBe(false);
    expect(takesPart("localhost", exclude)).toBe(false);
  });

  it("counts markdown, docs/ and the licence as docs", () => {
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("docs/adr/0004-fleet-relay.md")).toBe(true);
    expect(isDocsPath("LICENSE")).toBe(true);
    expect(isDocsPath("src/server/release.ts")).toBe(false);
    expect(isDocsPath("package.json")).toBe(false);
  });
});
