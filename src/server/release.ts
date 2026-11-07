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
 *    rollout and files an issue; nothing is rolled back. A machine named in
 *    `release:exclude` (`engage` unless set) takes no part, and neither does
 *    one whose name cannot be told.
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
import { HOLD_LABEL, POLL_MS, RELEASE_REPO } from "./github-events.js";
import { nameList, placeName } from "../worker-placement.js";
import { isVersion } from "./self-update.js";

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
/** How many times a gate the machinery could not run (a fetch, an install, the network) is tried before it is filed. */
export const TRANSIENT_TRIES = 3;
/** How old the last read of GitHub may be before the rule stops trusting it, hold included. */
export const STALE_READ_MS = 2 * POLL_MS + 15_000;
/** How long a machine that is offline when its turn comes is waited for, since the fleet reconnects after this server restarts. */
export const RECONNECT_MS = 3 * 60_000;
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
  /** Since when its turn came while it was offline. */
  offlineSince?: number;
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
  retry?: { sha: string; at: number; reason: string; tries?: number } | null;
  /** The issue the last gate failure filed, commented on by the next failure while it is open. */
  gateIssue?: number | null;
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
          gateIssue: raw.gateIssue ?? null,
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
  /**
   * What changed between the last version tag and `sha`; `tagged` when `sha` is that tag's commit,
   * and `bump` the version when `sha` is a bump commit whose tag never reached the remote.
   */
  changes(sha: string): Promise<{ lastTag: string | null; tagged: boolean; files: string[]; bump?: string | null } | null>;
  gate(sha: string): Promise<GateResult>;
  /**
   * Bump a patch on `sha`, push it to the default branch and push its tag. The version, why it could not,
   * or `existing`, the tag someone else already put on `sha`.
   */
  tag(sha: string): Promise<{ version: string } | { existing: string } | string>;
  /** Push the tag `v<version>` on `sha`, a bump commit already on the default branch. Null, or why it could not. */
  pushTag(sha: string, version: string): Promise<string | null>;
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
  /** The default branch's head, whether a hold is open, and when GitHub was read; null before a read. */
  github: () => { head: string; held: boolean; readAt: number } | null;
  fileIssue: (title: string, body: string) => Promise<number | null>;
  /** Comment on an issue if it is still open; false when it is closed or could not be reached. */
  commentIssue: (issue: number, body: string) => Promise<boolean>;
  /** Whether npm has the version yet. */
  published: (version: string) => Promise<boolean>;
  /** The machines that take part, this one among them. */
  machines: () => ReleaseMachine[];
  /** This machine's update job as it stands. */
  selfJob: () => { startedAt: number; state: "running" | "ok" | "failed"; line: string } | null;
  /** Start this machine's update to `version`; answers when the job began. It ends by restarting this server. */
  updateSelf: (version: string) => number | null;
  /** Update another machine to `version` and wait for how it went. */
  updateRemote: (machine: ReleaseMachine, version: string) => Promise<{ ok: boolean; line: string }>;
  /** A machine's version as its health check answers it; null when it does not answer as healthy. */
  health: (machine: ReleaseMachine) => Promise<string | null>;
  now?: () => number;
}

/** A preference naming the machines the rollout leaves out. */
export const RELEASE_EXCLUDE_KEY = "release:exclude";
/** Left out while `release:exclude` was never set: `engage` belongs to a client and joins only by choice. */
export const DEFAULT_RELEASE_EXCLUDE = ["engage"];

/** The machines the rollout leaves out: the preference when it was ever set (an empty list included), else the default. */
export function releaseExcludeList(value: unknown): string[] {
  return Array.isArray(value) ? (nameList(value) ?? []) : DEFAULT_RELEASE_EXCLUDE;
}

/**
 * Whether a machine takes part in the rollout: every machine does but those
 * `release:exclude` names, and one whose name cannot be told, which might be
 * one of them. `hostname` as the fleet reports it.
 */
export function takesPart(hostname: string | null | undefined, exclude: readonly string[]): boolean {
  const name = placeName(hostname ?? "");
  return name !== "" && name !== "localhost" && !exclude.includes(name);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|AUTH|COOKIE|SESSION/i;
const SECRET_SHAPES = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
/** How much of a failing step's output goes into a public issue. */
const ISSUE_OUTPUT_CHARS = 6_000;

/**
 * A failing gate's output as it may go into a public issue: its last lines,
 * at most `ISSUE_OUTPUT_CHARS`, with this server's secrets (any variable
 * whose name says it is one) and anything shaped like a token taken out, and
 * the home directory written as `~`.
 */
export function scrubOutput(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = tail(text);
  if (out.length > ISSUE_OUTPUT_CHARS) out = `…${out.slice(-ISSUE_OUTPUT_CHARS)}`;
  const values = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= 6)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join("[redacted]");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  if (env.HOME && env.HOME.length > 1) out = out.split(env.HOME).join("~");
  return out.replace(/```/g, "`\u200b``");
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
    // A read that stopped coming may have missed a hold opened since: nothing is done on it.
    if (now - github.readAt > STALE_READ_MS) {
      throw new Error(`GitHub was last read ${Math.round((now - github.readAt) / 60_000)} minutes ago; waiting for a fresh read`);
    }
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
      for (const a of release.attempts) {
        if (a.state === "updating" && a.startedAt !== undefined) a.startedAt += heldFor;
        if (a.offlineSince !== undefined) a.offlineSince += heldFor;
      }
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
    if (changes.bump) {
      await this.pushTag(sha, changes.bump);
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
    const tries = (this.file.retry?.sha === sha ? (this.file.retry.tries ?? 1) : 0) + 1;
    if (result.transient && tries < TRANSIENT_TRIES) {
      this.file.gate = null;
      this.file.retry = { sha, at: this.now(), reason: `${result.step} failed`, tries };
      this.log("skipped", `${short(sha)}: could not ${result.step}; trying again in ${RETRY_MS / 60_000} minutes`);
      return;
    }
    this.file.retry = null;
    const body = [
      `The release rule ran lint, tests and build on ${commitUrl(sha)} and \`${result.step}\` failed${result.transient ? ` ${tries} times` : ""}, so nothing was released. It waits for a new commit.`,
      "",
      "```",
      scrubOutput(result.output),
      "```",
    ].join("\n");
    // A broken main fails every merge until it is fixed: one issue says so, and each new failure is a comment on it.
    const open = this.file.gateIssue;
    const commented = open ? await this.deps.commentIssue(open, body) : false;
    const issue = commented ? open! : await this.deps.fileIssue(`Release gate failed on ${short(sha)}: ${result.step}`, body);
    if (issue) this.file.gateIssue = issue;
    this.file.gate = { sha, state: "failed", reason: `${result.step} failed`, at: this.now(), issue };
    const said = issue ? (commented ? `; commented on #${issue}` : `; filed #${issue}`) : "";
    this.log("failed", `${short(sha)}: ${result.step} failed${said}`, issueUrl(issue) ?? commitUrl(sha));
  }

  /** A bump commit on main whose tag never reached the remote: its tag is pushed again, not bumped past. */
  private async pushTag(sha: string, version: string): Promise<void> {
    const failed = this.file.retry;
    if (failed?.sha === sha && this.now() - failed.at < RETRY_MS) return;
    const why = await this.deps.repo.pushTag(sha, version);
    if (why) {
      const reason = `Could not push v${version} on ${short(sha)}: ${why}`;
      const again = failed?.sha === sha && failed.reason === reason;
      this.file.retry = { sha, at: this.now(), reason };
      if (again) this.save();
      else this.log("failed", `${reason}; trying again in ${RETRY_MS / 60_000} minutes`);
      return;
    }
    this.file.retry = null;
    this.file.gate = { sha, state: "skipped", reason: `${short(sha)} is v${version}`, at: this.now() };
    this.published(sha, version, `Pushed v${version} again on ${short(sha)}: its tag had not reached GitHub`);
  }

  private async tag(sha: string): Promise<void> {
    const tagged = await this.deps.repo.tag(sha);
    if (typeof tagged === "object" && "existing" in tagged) {
      // Released by hand while the rule waited: that release stands, and this head is not bumped again.
      this.file.retry = null;
      this.file.gate = { sha, state: "skipped", reason: `${short(sha)} is ${tagged.existing}`, at: this.now() };
      this.log("skipped", `${short(sha)} was tagged ${tagged.existing} meanwhile; nothing to release`);
      return;
    }
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
    this.published(sha, tagged.version, `Tagged v${tagged.version} on ${short(sha)}`);
  }

  /** A tag is on the remote: the rollout waits for npm to have it. */
  private published(sha: string, version: string, line: string): void {
    this.file.release = { sha, version, taggedAt: this.now(), state: "publishing", reason: "Waiting for npm", attempts: [] };
    this.log("ran", line, `https://github.com/${RELEASE_REPO}/releases/tag/v${version}`);
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
    release.reason = doneLine(release);
    this.log("done", release.reason);
  }

  /** This machine first, then the others by name; one offline is waited for when its turn comes. */
  private rolloutOrder(): Attempt[] {
    const machines = this.deps.machines();
    const self = machines.filter((m) => m.self);
    const others = machines.filter((m) => !m.self).sort((a, b) => a.name.localeCompare(b.name));
    return [...self, ...others].map((m) => ({ machine: m.id, name: m.name, self: m.self, state: "queued", reason: "Waiting its turn" }));
  }

  /** The attempt's outcome, or null while it is under way. */
  private async updateSelf(release: ReleaseRecord, attempt: Attempt): Promise<AttemptState | null> {
    const machine: ReleaseMachine = { id: attempt.machine, name: attempt.name, self: true, online: true };
    if (attempt.state === "queued") {
      Object.assign(attempt, { state: "updating", reason: "Updating", startedAt: this.now() });
      // Kept before the update starts: it ends by restarting this server.
      this.save();
      const jobStartedAt = this.deps.updateSelf(release.version);
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
      // After this server restarts every link to the fleet starts offline: a machine is given a while to reconnect.
      if (attempt.offlineSince === undefined) {
        Object.assign(attempt, { offlineSince: this.now(), reason: "Offline; waiting for it to reconnect" });
        this.save();
        return null;
      }
      if (this.now() - attempt.offlineSince < RECONNECT_MS) return null;
      return this.end(attempt, "skipped", `Offline for ${RECONNECT_MS / 60_000} minutes when its turn came`);
    }
    Object.assign(attempt, { state: "updating", reason: "Updating", startedAt: this.now() });
    this.save();
    const result = await this.deps.updateRemote(machine, release.version);
    if (!result.ok) return this.end(attempt, "failed", result.line || "The update failed");
    // Its server may still be coming back: health is read again each tick until the deadline.
    const version = await this.deps.health(machine);
    if (version === release.version) return this.end(attempt, "ok", `Healthy on v${version}`);
    attempt.reason = "Updated; waiting for it to answer on the new version";
    this.save();
    return null;
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

/** How a rollout that ran to its end left the fleet, naming every machine it passed over. */
function doneLine(release: ReleaseRecord): string {
  const names = (state: AttemptState) => release.attempts.filter((a) => a.state === state).map((a) => a.name);
  const ok = names("ok");
  const skipped = names("skipped");
  const on = `v${release.version} is on ${ok.join(", ") || "no machine"}`;
  return skipped.length > 0 ? `${on}; not updated: ${skipped.join(", ")}` : on;
}

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

/** The only variables the gate's steps get from this server: what finds the tools and sets the locale. */
const GATE_ENV_ALLOW = /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|SHELL|USER|LOGNAME)$/;

/**
 * What the gate's steps run with: the few variables `GATE_ENV_ALLOW` lets
 * through, so no token or key of this server's reaches code under test, and a
 * `HOME` and `TMUX_TMPDIR` of their own under `dir`, so a test that forgets
 * to isolate itself still cannot reach the live installation or its default
 * tmux socket. Its tmux tests pass `-L <name>` besides (CLAUDE.md), which is
 * what isolates tmux.
 */
export function gateEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(dir, "home");
  const tmux = join(dir, "tmux");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmux, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (GATE_ENV_ALLOW.test(k)) env[k] = v;
  return { ...env, HOME: home, TMUX_TMPDIR: tmux, CI: "1" };
}

/** Output that says the network or the registry failed, not the code. */
const NETWORK_ERROR = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network error|fetch failed|503 Service Unavailable|502 Bad Gateway)\b/i;

/** Whether a failed step is the machinery's: an install, or anything the network broke. */
export function isTransientFailure(step: string, output: string): boolean {
  return step === "install" || NETWORK_ERROR.test(output);
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
      const bump = await bumpOf(sha);
      if (bump) return { lastTag, tagged: false, files: [], bump };
      const diff = await git(["diff", "--name-only", `${lastTag}..${sha}`]);
      return diff.ok ? { lastTag, tagged: false, files: diff.output.split("\n").filter(Boolean) } : null;
    },

    async gate(sha) {
      if (!(await sync())) return { ok: false, step: "fetch", output: `could not fetch ${RELEASE_REPO}`, transient: true };
      return inWorktree<GateResult>(
        "gate",
        sha,
        async (tree) => {
          const env = gateEnv(join(opts.dir, "gate-env"));
          for (const step of steps) {
            const res = await exec(step.cmd, step.args, tree, 20 * 60_000, env);
            if (!res.ok) return { ok: false, step: step.name, output: res.output, transient: isTransientFailure(step.name, res.output) };
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
      // Someone released by hand while the rule waited: the fetch just brought their tag.
      const existing = await tagOn(sha);
      if (existing === undefined) return `could not read the tags on ${short(sha)}`;
      if (existing) return { existing };
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

    async pushTag(sha, version) {
      if (!(await sync())) return `could not fetch ${RELEASE_REPO}`;
      const tip = await git(["merge-base", "--is-ancestor", sha, `origin/${branch}`]);
      if (!tip.ok) return `${short(sha)} is not on ${branch}`;
      const tag = `v${version}`;
      if (!(await git(["tag", "-f", "-m", version, tag, sha])).ok) return `could not make ${tag}`;
      const pushed = await git(["push", "--quiet", "origin", `refs/tags/${tag}`]);
      return pushed.ok ? null : `the tag could not be pushed: ${tail(pushed.output, 5)}`;
    },
  };

  /** The version tag on `sha` as the remote has it; null when there is none, undefined when it could not be read. */
  async function tagOn(sha: string): Promise<string | null | undefined> {
    const res = await git(["tag", "--points-at", sha, "--list", "v[0-9]*"]);
    if (!res.ok) return undefined;
    return res.output.split("\n").map((t) => t.trim()).find(Boolean) ?? null;
  }

  /**
   * The version `sha` bumped to, when it is a bump commit (`npm version`'s:
   * the subject is the version its package.json holds) whose tag the remote
   * lacks, which is what a tag push that failed after its branch push leaves.
   */
  async function bumpOf(sha: string): Promise<string | null> {
    const subject = await git(["log", "-1", "--format=%s", sha]);
    const version = subject.ok ? subject.output.trim() : "";
    if (!isVersion(version)) return null;
    const pkg = await git(["show", `${sha}:package.json`]);
    try {
      if (!pkg.ok || (JSON.parse(pkg.output) as { version?: string }).version !== version) return null;
    } catch {
      return null;
    }
    // The clone fetched with `--prune-tags`, so a tag here is one the remote has.
    const tagged = await git(["rev-parse", "--verify", "--quiet", `refs/tags/v${version}`]);
    return tagged.ok ? null : version;
  }
}
