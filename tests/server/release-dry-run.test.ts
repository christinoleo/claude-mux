/**
 * A dry run of the release rule against a scratch repository: real git and
 * `npm version` on a clone of a bare repo in a temp directory, under a HOME
 * of its own, with the gate's steps and every machine faked. No real tag is
 * pushed and no machine is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ReleaseRule,
  SETTLE_MS,
  emptyReleaseFile,
  gitReleaseRepo,
  type ReleaseFile,
  type ReleaseMachine,
} from "../../src/server/release.js";

let scratch: string;
let remote: string;
let seed: string;
const savedEnv = { ...process.env };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commit(file: string, text: string, message: string): string {
  // The rule's bump lands on the remote, not here.
  if (git(seed, "ls-remote", "origin", "main")) git(seed, "pull", "-q", "--ff-only", "origin", "main");
  writeFileSync(join(seed, file), text);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", message);
  git(seed, "push", "-q", "origin", "HEAD:main");
  return git(seed, "rev-parse", "HEAD");
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "release-dry-run-"));
  // git and npm read their settings from HOME: an isolated one, never the real installation's.
  Object.assign(process.env, {
    HOME: join(scratch, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dry Run",
    GIT_AUTHOR_EMAIL: "dry@example.invalid",
    GIT_COMMITTER_NAME: "Dry Run",
    GIT_COMMITTER_EMAIL: "dry@example.invalid",
  });
  execFileSync("mkdir", ["-p", process.env.HOME!]);
  remote = join(scratch, "origin.git");
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  seed = join(scratch, "seed");
  git(scratch, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-b", "main");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ name: "scratch", version: "1.0.0", scripts: { version: "echo bumped > VERSION && git add VERSION" } }, null, 2) + "\n"
  );
  commit("README.md", "scratch\n", "start");
  git(seed, "tag", "v1.0.0");
  git(seed, "push", "-q", "origin", "v1.0.0");
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(scratch, { recursive: true, force: true });
});

describe("release dry run on a scratch repo", () => {
  it("shows each step: docs-only skipped, a failed gate filed, then gate, tag, npm and rollout", async () => {
    let failing = false;
    // The gate's steps get none of this process's variables, so the switch is a file.
    const flag = join(scratch, "fail-flag");
    const repo = gitReleaseRepo({
      dir: join(scratch, "release"),
      remote,
      // Stands in for lint, tests and build: fails while the test says so.
      steps: [{ name: "test", cmd: "sh", args: ["-c", `test ! -e '${flag}' || { echo "1 failed"; exit 1; }`] }],
    });
    let now = Date.UTC(2026, 10, 9, 12);
    let head = git(seed, "rev-parse", "HEAD");
    const issues: string[] = [];
    const store = { file: emptyReleaseFile() as ReleaseFile, load: () => store.file, save: (f: ReleaseFile) => (store.file = f) };
    const versions = new Map<string, string>([
      ["omarchy-id", "1.0.0"],
      ["beta-id", "1.0.0"],
    ]);
    const machines: ReleaseMachine[] = [
      { id: "omarchy-id", name: "omarchy", self: true, online: true },
      { id: "beta-id", name: "beta", self: false, online: true },
    ];
    let job: { startedAt: number; state: "running" | "ok" | "failed"; line: string } | null = null;
    const rule = new ReleaseRule({
      store,
      repo: {
        ...repo,
        gate: (sha) => {
          if (failing) writeFileSync(flag, "1");
          else rmSync(flag, { force: true });
          return repo.gate(sha);
        },
      },
      now: () => now,
      on: () => true,
      github: () => ({ head, held: false, readAt: now }),
      fileIssue: async (title) => {
        issues.push(title);
        return issues.length;
      },
      commentIssue: async () => false,
      published: async () => true,
      machines: () => machines,
      updateSelf: () => {
        job = { startedAt: now, state: "ok", line: "Updated" };
        versions.set("omarchy-id", "1.0.1");
        return now;
      },
      selfJob: () => job,
      updateRemote: async (m, version) => {
        expect(version).toBe("1.0.1");
        versions.set(m.id, "1.0.1");
        return { ok: true, line: "Updated" };
      },
      health: async (m) => versions.get(m.id) ?? null,
    });

    // The tag's own commit: nothing to release.
    await rule.tick();
    // Docs only.
    head = commit("NOTES.md", "notes\n", "docs");
    await rule.tick();
    // Code, with the gate failing.
    failing = true;
    head = commit("index.js", "console.log(1)\n", "code");
    await rule.tick();
    expect(issues).toEqual([`Release gate failed on ${head.slice(0, 7)}: test`]);
    // A fix, gate passing.
    failing = false;
    head = commit("index.js", "console.log(2)\n", "fix");
    await rule.tick();
    now += SETTLE_MS;
    await rule.tick();

    // The bump and its tag reached the scratch remote, and only it.
    expect(git(remote, "tag", "--list")).toBe("v1.0.0\nv1.0.1");
    expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("1.0.1");
    expect(git(remote, "show", "main:VERSION")).toBe("bumped");
    expect(git(remote, "rev-parse", "main^")).toBe(head);

    // The bump commit is the next head; it releases nothing.
    head = git(remote, "rev-parse", "main");
    for (let i = 0; i < 6; i++) await rule.tick();
    expect(store.file.release).toMatchObject({ version: "1.0.1", state: "done" });
    expect(store.file.gate).toMatchObject({ sha: head, state: "skipped" });

    const steps = store.file.log.map((l) => `${l.status}: ${l.reason}`).reverse();
    console.log(["Dry run:", ...steps].join("\n  "));
    expect(steps).toEqual([
      expect.stringMatching(/^skipped: [0-9a-f]{7} is v1\.0\.0$/),
      "skipped: Nothing to release since v1.0.0: only docs changed",
      expect.stringMatching(/^failed: [0-9a-f]{7}: test failed; filed #1$/),
      expect.stringMatching(/^ran: [0-9a-f]{7} passed lint, tests and build$/),
      expect.stringMatching(/^ran: Tagged v1\.0\.1 on [0-9a-f]{7}$/),
      "ran: npm has v1.0.1; rolling out",
      "done: omarchy: Healthy on v1.0.1",
      "done: beta: Healthy on v1.0.1",
      "done: v1.0.1 is on omarchy, beta",
      expect.stringMatching(/^skipped: [0-9a-f]{7} is v1\.0\.1$/),
    ]);
  }, 60_000);

  it("drops a tag a failed push left in its clone, so the same bump can go out", async () => {
    const dir = join(scratch, "release-3");
    const repo = gitReleaseRepo({ dir, remote, steps: [] });
    const head = git(remote, "rev-parse", "main");
    await repo.changes(head);
    git(join(dir, "repo"), "tag", "v9.9.9", head);
    await repo.changes(head);
    expect(git(join(dir, "repo"), "tag", "--list", "v9.9.9")).toBe("");
  }, 60_000);

  it("refuses to tag a head main has moved past", async () => {
    const repo = gitReleaseRepo({ dir: join(scratch, "release-2"), remote, steps: [] });
    const old = git(remote, "rev-parse", "main");
    commit("later.js", "1\n", "later");
    expect(await repo.tag(old)).toMatch(/no longer at/);
    expect(git(remote, "tag", "--list")).toBe("v1.0.0\nv1.0.1");
  }, 60_000);

  it("stops when the head was tagged by hand while the rule waited", async () => {
    const repo = gitReleaseRepo({ dir: join(scratch, "release-4"), remote, steps: [] });
    const head = commit("hand.js", "1\n", "hand");
    const before = git(remote, "tag", "--list");
    git(seed, "tag", "v7.0.0", head);
    git(seed, "push", "-q", "origin", "v7.0.0");
    expect(await repo.tag(head)).toEqual({ existing: "v7.0.0" });
    // Nothing bumped, nothing pushed.
    expect(git(remote, "rev-parse", "main")).toBe(head);
    expect(git(remote, "tag", "--list")).toBe(`${before}\nv7.0.0`);
  }, 60_000);

  it("pushes the tag of a bump commit whose tag never reached the remote, rather than bumping again", async () => {
    const dir = join(scratch, "release-5");
    const repo = gitReleaseRepo({ dir, remote, steps: [] });
    // What a tag push that failed after its branch push leaves: the bump on main, no tag.
    git(seed, "pull", "-q", "--ff-only", "origin", "main");
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "scratch", version: "7.0.1" }, null, 2) + "\n");
    git(seed, "commit", "-q", "-am", "7.0.1");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const bump = git(seed, "rev-parse", "HEAD");
    const changes = await repo.changes(bump);
    expect(changes).toMatchObject({ bump: { version: "7.0.1", parent: git(seed, "rev-parse", "HEAD^") } });
    // Asked to tag it, the rule pushes its tag rather than bumping to 7.0.2.
    expect(await repo.tag(bump)).toEqual({ version: "7.0.1" });
    expect(git(remote, "rev-list", "-n", "1", "v7.0.1")).toBe(bump);
    expect(git(remote, "rev-parse", "main")).toBe(bump);
    // Once tagged, it is the tag's own commit.
    expect(await repo.changes(bump)).toMatchObject({ tagged: true, lastTag: "v7.0.1" });
  }, 60_000);
});
