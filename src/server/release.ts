/**
 * The release rule: how a merge to claude-mux reaches npm and the fleet
 * (#203, decided in #186, map #177).
 *
 * It is the rule a push to the default branch runs when that project is
 * claude-mux itself, driven by the GitHub polling (`src/server/github-events.ts`),
 * which hands it the branch head and whether a hold is open. No Claude
 * session is started and no quota is spent.
 *
 * 1. **Gate.** Each new head is checked out in a worktree of a clone of its
 *    own, never Leo's checkout, and must pass lint, tests and the build. A
 *    failure files an issue and waits for a new commit: the same head is
 *    never gated twice.
 * 2. **Tag.** Ten minutes after the head last moved, a head that passed is
 *    bumped a patch and tagged, and the tag is pushed; `release.yml`
 *    publishes it to npm as before. A head whose commits since the last tag
 *    touch only docs releases nothing, and neither does the bump commit
 *    itself, which is the head the tag names.
 * 3. **Roll out.** Once npm has the version, this machine updates first,
 *    then its version and health are checked, then the other machines one
 *    by one. Each machine gets one attempt per version. A failure stops the
 *    rollout and files an issue; nothing is rolled back. A machine that keeps
 *    its projects (`queue:exclusive`, `engage` unless set) takes part only
 *    when named in `release:include`.
 *
 * An open issue labelled `release-hold` pauses all of it, wherever it is:
 * nothing is gated, tagged or updated while one is open, and the rule picks
 * up where it was once it is closed.
 *
 * This machine's own update restarts the server that runs the rule, so every
 * step is kept in `~/.claude-mux/release.json` before it is taken, and the
 * new server reads back how the update went.
 */

import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { HOLD_LABEL, RELEASE_REPO } from "./github-events.js";

/** How long after the last merge a release waits, so a burst of merges goes out as one. */
export const SETTLE_MS = 10 * 60_000;
/** How long npm has to show a pushed tag's version before the rollout is given up. */
export const PUBLISH_DEADLINE_MS = 30 * 60_000;
/** How long this machine has to come back on the new version after starting its update. */
export const SELF_DEADLINE_MS = 15 * 60_000;
/** How often the rule looks again while something is under way. */
export const RELEASE_TICK_MS = 15_000;
/** How long a tag that failed, or a gate the machinery could not run, waits before it is tried again. */
export const RETRY_MS = 5 * 60_000;
const LOG_LIMIT = 100;

/** A changed path that does not, on its own, make a release. */
export function isDocsPath(path: string): boolean {
  return /\.md$/i.test(path) || path.startsWith("docs/") || path === "LICENSE";
}

// ── what is kept ─────────────────────────────────────────────────────────────

export type GateState = "running" | "passed" | "failed" | "skipped";

export interface GateRecord {
  sha: string;
  state: GateState;
  /** Why it was skipped, or the step that failed. */
  reason: string;
  at: number;
  /** The issue a failure filed. */
  issue?: number | null;
}

export type AttemptState = "queued" | "updating" | "ok" | "failed" | "skipped";

export interface Attempt {
  /** The machine's id, as the fleet knows it. */
  machine: string;
  name: string;
  self: boolean;
  state: AttemptState;
  reason: string;
  startedAt?: number;
  /** For this machine: when the update job it started began, to tell it from an older one. */
  jobStartedAt?: number;
  endedAt?: number;
}

export type ReleaseState = "publishing" | "rolling-out" | "done" | "stopped";

export interface ReleaseRecord {
  sha: string;
  version: string;
  taggedAt: number;
  state: ReleaseState;
  reason: string;
  attempts: Attempt[];
  issue?: number | null;
}

export interface ReleaseLogEntry {
  at: number;
  /** What happened, in the screen's words. */
  status: "ran" | "skipped" | "done" | "failed";
  reason: string;
  url?: string;
}

export interface ReleaseFile {
  v: 1;
  /** The branch head as last read, and when the rule first saw it. */
  head: { sha: string; seenAt: number } | null;
  /** Since when a hold has been open, while one is. */
  heldAt?: number | null;
  /** A tag that failed, or a gate the machinery could not run, tried again only after `RETRY_MS`. */
  retry?: { sha: string; at: number; reason: string } | null;
  gate: GateRecord | null;
  release: ReleaseRecord | null;
  /** Newest first. */
  log: ReleaseLogEntry[];
}

export interface ReleaseStore {
  load(): ReleaseFile;
  save(file: ReleaseFile): void;
}

export function emptyReleaseFile(): ReleaseFile {
  return { v: 1, head: null, gate: null, release: null, log: [] };
}

export function fileReleaseStore(path: string): ReleaseStore {
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReleaseFile>;
        return {
          v: 1,
          head: raw.head ?? null,
          gate: raw.gate ?? null,
          release: raw.release ?? null,
          heldAt: raw.heldAt ?? null,
          retry: raw.retry ?? null,
          log: Array.isArray(raw.log) ? raw.log : [],
        };
      } catch {
        return emptyReleaseFile();
      }
    },
    save(file) {
      writeFileAtomic(path, JSON.stringify(file, null, 2));
    },
  };
}

// ── what the rule is handed ──────────────────────────────────────────────────

/** `transient` when the machinery failed (a fetch, a checkout), not the code: tried again later, not filed. */
export type GateResult = { ok: true } | { ok: false; step: string; output: string; transient?: boolean };

/** The repository, as the rule acts on it. Each answers null (or a string, for a tag) when it could not. */
export interface ReleaseRepo {
  /** What changed between the last version tag and `sha`; `tagged` when `sha` is that tag's commit. */
  changes(sha: string): Promise<{ lastTag: string | null; tagged: boolean; files: string[] } | null>;
  gate(sha: string): Promise<GateResult>;
  /** Bump a patch on `sha`, push it to the default branch and push its tag. The version, or why it could not. */
  tag(sha: string): Promise<{ version: string } | string>;
}

export interface ReleaseMachine {
  id: string;
  name: string;
  self: boolean;
  online: boolean;
}

export interface ReleaseDeps {
  store: ReleaseStore;
  repo: ReleaseRepo;
  /** The default branch's head and whether a hold is open, as the last read of GitHub found them; null before one. */
  github: () => { head: string; held: boolean } | null;
  fileIssue: (title: string, body: string) => Promise<number | null>;
  /** Whether npm has the version yet. */
  published: (version: string) => Promise<boolean>;
  /** The machines that take part, this one among them. */
  machines: () => ReleaseMachine[];
  /** Start this machine's own update; answers when the job began. It ends by restarting this server. */
  updateSelf: () => number | null;
  /** This machine's update job as it stands. */
  selfJob: () => { startedAt: number; state: "running" | "ok" | "failed"; line: string } | null;
  /** Update another machine and wait for how it went. */
  updateRemote: (machine: ReleaseMachine) => Promise<{ ok: boolean; line: string }>;
  /** A machine's version as its health check answers it; null when it does not answer as healthy. */
  health: (machine: ReleaseMachine) => Promise<string | null>;
  now?: () => number;
}

/** A preference naming the machines that take part although they keep their projects (`queue:exclusive`). */
export const RELEASE_INCLUDE_KEY = "release:include";

/**
 * Whether a machine takes part in the rollout: every machine does, but one
 * that keeps its projects (`engage` unless set) only once it is named in
 * `release:include`. Names as `placeName()` gives them.
 */
export function takesPart(name: string, exclusive: readonly string[], include: readonly string[] | null): boolean {
  return !exclusive.includes(name) || (include ?? []).includes(name);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

// ── the rule ─────────────────────────────────────────────────────────────────

export class ReleaseRule {
  private file: ReleaseFile;
  private readonly now: () => number;
  private ticking: Promise<void> | null = null;
  /** The last thing a tick failed at, for the screen. */
  lastError: string | null = null;

  constructor(private readonly deps: ReleaseDeps) {
    this.now = deps.now ?? Date.now;
    this.file = deps.store.load();
    // A gate the server stopped in the middle of is run again.
    if (this.file.gate?.state === "running") this.file.gate = null;
  }

  state(): ReleaseFile {
    return this.file;
  }

  /** Take the next step that is due. One tick at a time; a tick asked for meanwhile joins it. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.step();
        this.lastError = null;
      } catch (err) {
        this.lastError = (err as Error).message;
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async step(): Promise<void> {
    const github = this.deps.github();
    if (!github) return;
    const now = this.now();
    if (this.file.head?.sha !== github.head) {
      this.file.head = { sha: github.head, seenAt: now };
      this.save();
    }
    if (github.held) {
      this.file.heldAt ??= now;
      if (this.file.log[0]?.reason !== HELD_REASON) this.log("skipped", HELD_REASON);
      return;
    }
    if (this.file.heldAt != null) this.resume(now - this.file.heldAt);

    // A rollout under way finishes before anything newer is tagged.
    const release = this.file.release;
    if (release && (release.state === "publishing" || release.state === "rolling-out")) {
      await this.advance(release);
      return;
    }

    const head = this.file.head!;
    if (this.file.gate?.sha !== head.sha) {
      const failed = this.file.retry;
      if (!this.file.gate && failed?.sha === head.sha && now - failed.at < RETRY_MS) return;
      await this.runGate(head.sha);
      return;
    }
    if (this.file.gate.state !== "passed") return;
    if (release?.sha === head.sha) return;
    if (now - head.seenAt < SETTLE_MS) return;
    const failed = this.file.retry;
    if (failed?.sha === head.sha && now - failed.at < RETRY_MS) return;
    await this.tag(head.sha);
  }

  /** A hold has lifted: the deadlines under way are moved on by as long as it lasted, so it costs none of their time. */
  private resume(heldFor: number): void {
    const release = this.file.release;
    if (release && (release.state === "publishing" || release.state === "rolling-out")) {
      release.taggedAt += heldFor;
      for (const a of release.attempts) if (a.state === "updating" && a.startedAt !== undefined) a.startedAt += heldFor;
    }
    this.file.heldAt = null;
    this.save();
  }

  private async runGate(sha: string): Promise<void> {
    const changes = await this.deps.repo.changes(sha);
    if (!changes) {
      this.lastError = `could not read what changed up to ${short(sha)}`;
      return;
    }
    const skip = changes.tagged
      ? `${short(sha)} is ${changes.lastTag}`
      : changes.files.every(isDocsPath)
        ? `Nothing to release since ${changes.lastTag ?? "the start"}: only docs changed`
        : null;
    if (skip) {
      this.file.gate = { sha, state: "skipped", reason: skip, at: this.now() };
      this.log("skipped", skip);
      return;
    }
    this.file.gate = { sha, state: "running", reason: "Lint, tests and build", at: this.now() };
    this.save();
    const result = await this.deps.repo.gate(sha);
    // A newer head that came while it ran is gated on the next tick; this answer still stands for its own.
    if (result.ok) {
      this.file.gate = { sha, state: "passed", reason: "Lint, tests and build passed", at: this.now() };
      this.log("ran", `${short(sha)} passed lint, tests and build`, commitUrl(sha));
      return;
    }
    if (result.transient) {
      this.file.gate = null;
      this.file.retry = { sha, at: this.now(), reason: `${result.step} failed` };
      this.log("skipped", `${short(sha)}: could not ${result.step}; trying again in ${RETRY_MS / 60_000} minutes`);
      return;
    }
    const issue = await this.deps.fileIssue(
      `Release gate failed on ${short(sha)}: ${result.step}`,
      [
        `The release rule ran lint, tests and build on ${commitUrl(sha)} and \`${result.step}\` failed, so nothing was released. It waits for a new commit.`,
        "",
        "```",
        tail(result.output),
        "```",
      ].join("\n")
    );
    this.file.gate = { sha, state: "failed", reason: `${result.step} failed`, at: this.now(), issue };
    this.log("failed", `${short(sha)}: ${result.step} failed${issue ? `; filed #${issue}` : ""}`, issueUrl(issue) ?? commitUrl(sha));
  }

  private async tag(sha: string): Promise<void> {
    const tagged = await this.deps.repo.tag(sha);
    if (typeof tagged === "string") {
      // Most often main moved under it, and the next head is gated and waited for afresh; else it is tried again later.
      const reason = `Could not tag ${short(sha)}: ${tagged}`;
      const again = this.file.retry?.sha === sha && this.file.retry.reason === reason;
      this.file.retry = { sha, at: this.now(), reason };
      if (again) this.save();
      else this.log("failed", `${reason}; trying again in ${RETRY_MS / 60_000} minutes`);
      return;
    }
    this.file.retry = null;
    this.file.release = {
      sha,
      version: tagged.version,
      taggedAt: this.now(),
      state: "publishing",
      reason: "Waiting for npm",
      attempts: [],
    };
    this.log("ran", `Tagged v${tagged.version} on ${short(sha)}`, `https://github.com/${RELEASE_REPO}/releases/tag/v${tagged.version}`);
  }

  private async advance(release: ReleaseRecord): Promise<void> {
    if (release.state === "publishing") {
      if (!(await this.deps.published(release.version))) {
        if (this.now() - release.taggedAt > PUBLISH_DEADLINE_MS) {
          await this.halt(release, `npm did not have v${release.version} ${PUBLISH_DEADLINE_MS / 60_000} minutes after the tag`);
        }
        return;
      }
      release.state = "rolling-out";
      release.reason = "Rolling out";
      release.attempts = this.rolloutOrder();
      this.log("ran", `npm has v${release.version}; rolling out`);
    }

    const attempt = release.attempts.find((a) => a.state !== "ok" && a.state !== "skipped");
    if (attempt) {
      if (attempt.state === "failed") return;
      const machine = this.deps.machines().find((m) => m.id === attempt.machine);
      const outcome = attempt.self ? await this.updateSelf(release, attempt) : await this.updateRemote(release, attempt, machine);
      // Under way (null): this machine restarts, or another one is looked at next tick.
      // Otherwise one machine per tick, so a hold opened meanwhile is heard before the next.
      if (outcome === "failed") await this.halt(release, `${attempt.name}: ${attempt.reason}`);
      return;
    }
    release.state = "done";
    release.reason = `Every machine runs v${release.version}`;
    this.log("done", `v${release.version} is on ${release.attempts.filter((a) => a.state === "ok").map((a) => a.name).join(", ") || "no machine"}`);
  }

  /** This machine first, then the others by name; the offline and the excluded are passed over, as recorded. */
  private rolloutOrder(): Attempt[] {
    const machines = this.deps.machines();
    const self = machines.filter((m) => m.self);
    const others = machines.filter((m) => !m.self).sort((a, b) => a.name.localeCompare(b.name));
    return [...self, ...others].map((m) => ({
      machine: m.id,
      name: m.name,
      self: m.self,
      state: m.online ? "queued" : "skipped",
      reason: m.online ? "Waiting its turn" : "Offline when the rollout began",
    }));
  }

  /** The attempt's outcome, or null while it is under way. */
  private async updateSelf(release: ReleaseRecord, attempt: Attempt): Promise<AttemptState | null> {
    const machine: ReleaseMachine = { id: attempt.machine, name: attempt.name, self: true, online: true };
    if (attempt.state === "queued") {
      Object.assign(attempt, { state: "updating", reason: "Updating", startedAt: this.now() });
      // Kept before the update starts: it ends by restarting this server.
      this.save();
      const jobStartedAt = this.deps.updateSelf();
      if (jobStartedAt === null) return this.end(attempt, "failed", "The update could not start");
      attempt.jobStartedAt = jobStartedAt;
      this.save();
      return null;
    }
    const job = this.deps.selfJob();
    const ours = job && attempt.jobStartedAt !== undefined && job.startedAt === attempt.jobStartedAt ? job : null;
    if (ours?.state === "failed") return this.end(attempt, "failed", ours.line || "The update failed");
    if (ours?.state === "running") return this.timeout(attempt, release);
    const version = await this.deps.health(machine);
    if (version === release.version) return this.end(attempt, "ok", `Healthy on v${version}`);
    return this.timeout(attempt, release, version);
  }

  private timeout(attempt: Attempt, release: ReleaseRecord, version?: string | null): AttemptState | null {
    if (this.now() - (attempt.startedAt ?? 0) <= SELF_DEADLINE_MS) return null;
    const on = version ? `still on v${version}` : "not answering as healthy";
    return this.end(attempt, "failed", `${on} ${SELF_DEADLINE_MS / 60_000} minutes after its update to v${release.version} began`);
  }

  private async updateRemote(release: ReleaseRecord, attempt: Attempt, machine: ReleaseMachine | undefined): Promise<AttemptState | null> {
    if (attempt.state === "updating") {
      // This server stopped while that machine updated: its one attempt is judged by where it is now,
      // given the same while to come back as this machine's own update.
      const version = machine ? await this.deps.health(machine) : null;
      return version === release.version ? this.end(attempt, "ok", `Healthy on v${version}`) : this.timeout(attempt, release, version);
    }
    if (!machine?.online) {
      // It went away after the rollout began; it is not waited for.
      return this.end(attempt, "skipped", "Offline when its turn came");
    }
    Object.assign(attempt, { state: "updating", reason: "Updating", startedAt: this.now() });
    this.save();
    const result = await this.deps.updateRemote(machine);
    if (!result.ok) return this.end(attempt, "failed", result.line || "The update failed");
    const version = await this.deps.health(machine);
    if (version !== release.version) {
      return this.end(attempt, "failed", `Updated, but it answers ${version ? `v${version}` : "as unhealthy"}`);
    }
    return this.end(attempt, "ok", `Healthy on v${version}`);
  }

  /** Records the attempt's outcome (saved with its log line) and answers it. */
  private end(attempt: Attempt, state: AttemptState, reason: string): AttemptState {
    Object.assign(attempt, { state, reason, endedAt: this.now() });
    this.log(state === "ok" ? "done" : state === "failed" ? "failed" : "skipped", `${attempt.name}: ${reason}`);
    return state;
  }

  private async halt(release: ReleaseRecord, why: string): Promise<void> {
    release.state = "stopped";
    release.reason = why;
    for (const a of release.attempts) {
      if (a.state === "queued") Object.assign(a, { state: "skipped", reason: "Not tried: the rollout stopped" });
    }
    this.save();
    const done = release.attempts.filter((a) => a.state === "ok").map((a) => a.name);
    release.issue = await this.deps.fileIssue(
      `Rollout of v${release.version} stopped`,
      [
        `The release rule stopped rolling out v${release.version}: ${why}.`,
        "",
        done.length > 0 ? `Already updated: ${done.join(", ")}. Nothing was rolled back.` : "No machine was updated.",
        "",
        "The next merge to main releases and rolls out again.",
      ].join("\n")
    );
    this.log("failed", `Rollout of v${release.version} stopped: ${why}`, issueUrl(release.issue));
  }

  private log(status: ReleaseLogEntry["status"], reason: string, url?: string): void {
    this.file.log = [{ at: this.now(), status, reason, ...(url ? { url } : {}) }, ...this.file.log].slice(0, LOG_LIMIT);
    this.save();
  }

  private save(): void {
    this.deps.store.save(this.file);
  }
}

const HELD_REASON = `Paused: an issue labelled ${HOLD_LABEL} is open`;

function commitUrl(sha: string): string {
  return `https://github.com/${RELEASE_REPO}/commit/${sha}`;
}

function issueUrl(issue: number | null | undefined): string | undefined {
  return issue ? `https://github.com/${RELEASE_REPO}/issues/${issue}` : undefined;
}

// ── the repository, with git ─────────────────────────────────────────────────

export interface Exec {
  (cmd: string, args: string[], cwd: string | undefined, timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }>;
}

export const realExec: Exec = (cmd, args, cwd, timeoutMs = 10 * 60_000, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}` })
    );
  });

export interface GitRepoOptions {
  /** Where the rule keeps its clone and its worktrees; never a checkout someone works in. */
  dir: string;
  /** What to clone, asked for only when the clone is first made. */
  remote: string | (() => Promise<string | null>);
  /** The default branch. */
  branch?: string;
  /** Each gate step, run in the worktree in turn. */
  steps?: { name: string; cmd: string; args: string[] }[];
  exec?: Exec;
}

export const GATE_STEPS: NonNullable<GitRepoOptions["steps"]> = [
  { name: "install", cmd: "bun", args: ["install", "--frozen-lockfile"] },
  { name: "lint", cmd: "bun", args: ["run", "lint"] },
  { name: "test", cmd: "bun", args: ["run", "test"] },
  { name: "build", cmd: "bun", args: ["run", "build"] },
];

/**
 * What the gate's steps run with: a HOME of their own, and nothing that names
 * this server's tmux, sessions or settings, so a test that forgets to isolate
 * itself still cannot reach the live installation. Its tmux tests pass
 * `-L <name>` besides (CLAUDE.md), which is what isolates tmux.
 */
export function gateEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(TMUX|TMUX_PANE|TMUX_TMPDIR|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_MUX_.*|MAESTRO_.*)$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, HOME: home, CI: "1" };
}

/** The repository as a clone of its own under `dir`, each gate and tag in a fresh worktree. */
export function gitReleaseRepo(opts: GitRepoOptions): ReleaseRepo {
  const exec = opts.exec ?? realExec;
  const branch = opts.branch ?? "main";
  const steps = opts.steps ?? GATE_STEPS;
  const clone = join(opts.dir, "repo");
  const git = (args: string[], cwd = clone) => exec("git", args, cwd);

  async function sync(): Promise<boolean> {
    if (!existsSync(join(clone, ".git"))) {
      const remote = typeof opts.remote === "string" ? opts.remote : await opts.remote();
      if (!remote) return false;
      mkdirSync(opts.dir, { recursive: true });
      rmSync(clone, { recursive: true, force: true });
      if (!(await git(["clone", "--quiet", remote, clone], opts.dir)).ok) return false;
    }
    // `--prune-tags`: a tag a failed push left here, never on the remote, would block the same bump and pass for a release.
    return (await git(["fetch", "--quiet", "--prune", "--prune-tags", "--tags", "--force", "origin"])).ok;
  }

  /** A fresh detached worktree at `sha`, handed to `use` and removed afterwards. */
  async function inWorktree<T>(name: string, sha: string, use: (dir: string) => Promise<T>, fallback: T): Promise<T> {
    const tree = join(opts.dir, name);
    const clear = async () => {
      await git(["worktree", "remove", "--force", tree]);
      rmSync(tree, { recursive: true, force: true });
    };
    await clear();
    await git(["worktree", "prune"]);
    if (!(await git(["worktree", "add", "--quiet", "--detach", tree, sha])).ok) return fallback;
    try {
      return await use(tree);
    } finally {
      await clear();
    }
  }

  return {
    async changes(sha) {
      if (!(await sync())) return null;
      const described = await git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", sha]);
      const lastTag = described.ok ? described.output.trim() : null;
      if (!lastTag) {
        const all = await git(["ls-tree", "-r", "--name-only", sha]);
        return all.ok ? { lastTag: null, tagged: false, files: all.output.split("\n").filter(Boolean) } : null;
      }
      const at = await git(["rev-list", "-n", "1", lastTag]);
      if (!at.ok) return null;
      if (at.output.trim() === sha) return { lastTag, tagged: true, files: [] };
      const diff = await git(["diff", "--name-only", `${lastTag}..${sha}`]);
      return diff.ok ? { lastTag, tagged: false, files: diff.output.split("\n").filter(Boolean) } : null;
    },

    async gate(sha) {
      if (!(await sync())) return { ok: false, step: "fetch", output: `could not fetch ${RELEASE_REPO}`, transient: true };
      return inWorktree<GateResult>(
        "gate",
        sha,
        async (tree) => {
          for (const step of steps) {
            const res = await exec(step.cmd, step.args, tree, 20 * 60_000, gateEnv(join(opts.dir, "home")));
            if (!res.ok) return { ok: false, step: step.name, output: res.output };
          }
          return { ok: true };
        },
        { ok: false, step: "checkout", output: `could not check out ${sha}`, transient: true }
      );
    },

    async tag(sha) {
      if (!(await sync())) return `could not fetch ${RELEASE_REPO}`;
      const tip = await git(["rev-parse", `origin/${branch}`]);
      if (!tip.ok || tip.output.trim() !== sha) return `${branch} is no longer at ${short(sha)}`;
      return inWorktree<{ version: string } | string>(
        "tag",
        sha,
        async (tree) => {
          // `npm version` commits and tags, and runs the package's `version` script on the way.
          const bumped = await exec("npm", ["version", "patch", "-m", "%s"], tree);
          if (!bumped.ok) return `npm version failed: ${tail(bumped.output, 5)}`;
          const version = (JSON.parse(readFileSync(join(tree, "package.json"), "utf-8")) as { version: string }).version;
          // The branch first: a tag whose commit main does not hold is never pushed.
          const pushed = await exec("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], tree);
          if (!pushed.ok) {
            await git(["tag", "-d", `v${version}`]);
            return `the bump could not be pushed: ${tail(pushed.output, 5)}`;
          }
          const tagPushed = await exec("git", ["push", "--quiet", "origin", `refs/tags/v${version}`], tree);
          if (!tagPushed.ok) return `the tag could not be pushed: ${tail(tagPushed.output, 5)}`;
          return { version };
        },
        `could not check out ${sha}`
      );
    },
  };
}
