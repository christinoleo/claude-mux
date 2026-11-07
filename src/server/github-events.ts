/**
 * The events claude-mux acts on, found by reading GitHub (#177, #180, #183).
 *
 * There is no webhook. About once a minute one GraphQL query reads, for every
 * project enabled in the state map (`src/db/event-map-json.ts`), the head of
 * its default branch and its open issues labelled `ready-for-agent`. That
 * costs 1 point however many projects are on. Only an issue whose
 * `updatedAt` moved since the last read is read again in full (its labels,
 * comments, renames and edits, with who made each), in a second query that
 * also costs 1 point for all of them together. State is read, never the
 * events feed, so an event missed while a read failed or the server was down
 * is still there on the next read; nothing fires in bulk on return, because
 * each event is recorded once by a key that names it.
 *
 * Two events exist. An issue is ready when the latest `ready-for-agent` label
 * on it was applied by Leo, the account `gh` is logged in as, and nobody else
 * commented, renamed, edited or took a label off it afterwards. His own later edits pass, and so
 * do an agent's, since maestro's workers act under his token; a Bot does not,
 * since a stranger can set off a workflow or app. An issue someone else touched
 * after the label is not ready; it waits in Needs you until Leo approves it
 * again, which re-applies the label under his name. A push is the default
 * branch's head moving; the first read after enabling only notes where it is.
 *
 * What each event does comes from the map. The rule records that the event
 * was seen. `session` on an issue puts it in `readyIssues()`, which the worker
 * queue (`src/server/worker-queue.ts`) reads after every sweep and starts a
 * worker from when this machine has room.
 */

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { getSessionsDir } from "../db/sessions-json.js";
import { enabledProjects, type EventAction, type EventKind, type ProjectEventMap } from "../db/event-map-json.js";
import { MACHINE_OFF, machineOn } from "./machine-switch.js";
import type { InboxTicket } from "../types/ws-messages.js";

export const READY_LABEL = "ready-for-agent";
/** An open issue with this label pauses the release rule (`src/server/release.ts`). */
export const HOLD_LABEL = "release-hold";
/** The project whose pushes the release rule takes, when its push event is set to the rule. */
export const RELEASE_REPO = "christinoleo/claude-mux";
/** How often GitHub is read: the delay #180 measured as costing about 60 points an hour. */
export const POLL_MS = 60_000;
/** How long the points spent are summed over, for the screen. */
const QUOTA_WINDOW_MS = 60 * 60_000;
/** How many recorded events are kept. */
const LOG_LIMIT = 200;
/** A sweep reads at most this many ready issues per project. */
const READY_PAGE = 50;
/** A ready list older than this is not handed out: the reads since failed, or stopped. */
export const READY_MAX_AGE_MS = 3 * POLL_MS;

// ── what GitHub answers ──────────────────────────────────────────────────────

export interface Actor {
  __typename?: string;
  login?: string | null;
}

export type TimelineNode =
  | { __typename: "LabeledEvent"; createdAt: string; label?: { name: string } | null; actor?: Actor | null }
  | { __typename: "UnlabeledEvent"; createdAt: string; label?: { name: string } | null; actor?: Actor | null }
  | { __typename: "RenamedTitleEvent"; createdAt: string; actor?: Actor | null }
  | {
      __typename: "IssueComment";
      createdAt: string;
      lastEditedAt?: string | null;
      author?: Actor | null;
      editor?: Actor | null;
    };

export interface IssueDetail {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  timelineItems: { nodes: (TimelineNode | null)[] };
  /** Read with the rest; a change of label moves `updatedAt`, so it is never stale. */
  labels?: { nodes: ({ name: string } | null)[] } | null;
  userContentEdits?: { nodes: ({ editedAt: string; editor?: Actor | null } | null)[] } | null;
}

interface SweepRepo {
  nameWithOwner: string;
  defaultBranchRef: { name: string; target: { oid: string; messageHeadline?: string } | null } | null;
  issues: {
    nodes: ({ number: number; updatedAt: string; issueDependenciesSummary?: { blockedBy: number } | null } | null)[];
  };
  /** Open issues labelled `release-hold`: read for every project, since it costs nothing more. */
  holds?: { totalCount: number } | null;
}

interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

/** Runs one GraphQL query and answers its `data`, or null when it could not. */
export type GraphqlRunner = (query: string) => Promise<Record<string, unknown> | null>;

/** Runs `gh` with these arguments; false when it failed. */
export type GhRunner = (args: string[]) => Promise<boolean>;

// ── the rule for Leo's own action ────────────────────────────────────────────

/** What someone other than Leo did to an issue marked ready. */
export type StrangerAct = "labelled" | "unlabelled" | "commented" | "renamed" | "edited";

/** How Needs you words each act. */
const ACT_PHRASE: Record<StrangerAct, string> = {
  labelled: "labelled",
  unlabelled: "took a label off",
  commented: "commented",
  renamed: "renamed",
  edited: "edited",
};

export type Readiness =
  | { state: "ready"; labeledAt: string }
  /** Someone else acted after the label, or applied it: Leo has to approve it again. */
  | { state: "approve"; labeledAt: string; by: string; what: StrangerAct; at: string }
  | { state: "none" };

/**
 * Leo himself, or one of his agents, which act under his token. A Bot is not
 * trusted: a workflow or app can be set off by a stranger and carry his words.
 */
export function trusted(actor: Actor | null | undefined, viewer: string): boolean {
  if (!actor) return false;
  return !!actor.login && actor.login.toLowerCase() === viewer.toLowerCase();
}

function who(actor: Actor | null | undefined): string {
  return actor?.login ?? "someone";
}

/**
 * Whether an issue counts as ready (#183): the latest `ready-for-agent` on it
 * is Leo's, and nothing anyone else did came after it. Of several such acts
 * the latest is reported, since that is what Leo approves.
 */
export function readiness(issue: IssueDetail, viewer: string): Readiness {
  const nodes = issue.timelineItems.nodes.filter((n): n is TimelineNode => !!n);
  const label = nodes
    .filter((n) => n.__typename === "LabeledEvent" && n.label?.name === READY_LABEL)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1) as Extract<TimelineNode, { __typename: "LabeledEvent" }> | undefined;
  if (!label) return { state: "none" };
  const labeledAt = label.createdAt;
  if (!trusted(label.actor, viewer)) {
    return { state: "approve", labeledAt, by: who(label.actor), what: "labelled", at: labeledAt };
  }
  const after = (at: string | null | undefined): at is string => !!at && Date.parse(at) > Date.parse(labeledAt);
  const acts: { by: Actor | null | undefined; what: Exclude<StrangerAct, "labelled">; at: string }[] = [];
  for (const n of nodes) {
    if (n.__typename === "RenamedTitleEvent" && after(n.createdAt)) acts.push({ by: n.actor, what: "renamed", at: n.createdAt });
    // A label taken off (`hold`, `stop-at-pr`) can loosen what a worker may do.
    if (n.__typename === "UnlabeledEvent" && after(n.createdAt)) acts.push({ by: n.actor, what: "unlabelled", at: n.createdAt });
    if (n.__typename === "IssueComment") {
      if (after(n.createdAt)) acts.push({ by: n.author, what: "commented", at: n.createdAt });
      if (after(n.lastEditedAt)) acts.push({ by: n.editor, what: "edited", at: n.lastEditedAt });
    }
  }
  for (const e of issue.userContentEdits?.nodes ?? []) {
    if (e && after(e.editedAt)) acts.push({ by: e.editor, what: "edited", at: e.editedAt });
  }
  const stranger = acts.filter((a) => !trusted(a.by, viewer)).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (stranger) return { state: "approve", labeledAt, by: who(stranger.by), what: stranger.what, at: stranger.at };
  return { state: "ready", labeledAt };
}

// ── the queries ──────────────────────────────────────────────────────────────

function str(s: string): string {
  return JSON.stringify(s);
}

function splitSlug(slug: string): [string, string] {
  const [owner, name] = slug.split("/");
  return [owner, name];
}

/** One query for every enabled project: its branch head and its ready issues. 1 point for up to 100 projects. */
export function sweepQuery(slugs: string[]): string {
  const repos = slugs.map((slug, i) => {
    const [owner, name] = splitSlug(slug);
    return `r${i}: repository(owner: ${str(owner)}, name: ${str(name)}) {
    nameWithOwner
    defaultBranchRef { name target { oid ... on Commit { messageHeadline } } }
    issues(states: OPEN, labels: [${str(READY_LABEL)}], first: ${READY_PAGE}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number updatedAt issueDependenciesSummary { blockedBy } }
    }
    holds: issues(states: OPEN, labels: [${str(HOLD_LABEL)}]) { totalCount }
  }`;
  });
  return `query {\n  viewer { login }\n  rateLimit { cost remaining resetAt }\n  ${repos.join("\n  ")}\n}`;
}

const ACTOR = "actor { __typename login }";

/** The issues whose `updatedAt` moved, read in full in one query. */
export function detailQuery(wanted: { slug: string; number: number }[]): string {
  const parts = wanted.map(({ slug, number }, i) => {
    const [owner, name] = splitSlug(slug);
    return `d${i}: repository(owner: ${str(owner)}, name: ${str(name)}) {
    issue(number: ${number}) {
      number title url updatedAt
      labels(first: 30) { nodes { name } }
      timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT, ISSUE_COMMENT], last: 100) {
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } ${ACTOR} }
          ... on UnlabeledEvent { createdAt label { name } ${ACTOR} }
          ... on RenamedTitleEvent { createdAt ${ACTOR} }
          ... on IssueComment { createdAt lastEditedAt author { __typename login } editor { __typename login } }
        }
      }
      userContentEdits(last: 20) { nodes { editedAt editor { __typename login } } }
    }
  }`;
  });
  return `query {\n  rateLimit { cost remaining resetAt }\n  ${parts.join("\n  ")}\n}`;
}

// ── what is kept across restarts ─────────────────────────────────────────────

export interface SeenEvent {
  /** Names the event, so it is recorded once: `slug#n@labeledAt` or `slug@sha`. */
  key: string;
  at: number;
  repo: string;
  kind: EventKind;
  action: EventAction;
  /** What the action did. */
  outcome: string;
  /** Passed over, with the machine's switch off. */
  skipped?: true;
  title: string;
  url: string;
}

interface RepoCursor {
  /** The default branch's head as last read; null until the first read after enabling. */
  head: string | null;
  /** The ready events recorded for issues still ready. */
  seen: string[];
}

export interface EventsFile {
  v: 1;
  repos: Record<string, RepoCursor>;
  log: SeenEvent[];
}

export interface EventStore {
  load(): EventsFile;
  save(file: EventsFile): void;
}

export function fileEventStore(path: string = join(dirname(getSessionsDir()), "events.json")): EventStore {
  return {
    load() {
      let raw: Partial<EventsFile> = {};
      try {
        raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<EventsFile>;
      } catch {
        // Missing or torn: start afresh.
      }
      return { v: 1, repos: raw.repos ?? {}, log: Array.isArray(raw.log) ? raw.log : [] };
    },
    save(file) {
      writeFileAtomic(path, JSON.stringify(file, null, 2));
    },
  };
}

// ── the poller ───────────────────────────────────────────────────────────────

export interface PollerDeps {
  graphql: GraphqlRunner;
  gh: GhRunner;
  store: EventStore;
  /** The state map's enabled projects; read afresh on every sweep, so a change applies at once. */
  projects: () => Map<string, ProjectEventMap>;
  now?: () => number;
  /** Told whenever the issues waiting for approval change, so Needs you hears at once. */
  onApprovals?: () => void;
  /** The machine's switch (`machine-switch.ts`): off, an event is recorded as skipped. */
  on: () => boolean;
}

export interface Approval {
  repo: string;
  /** The project's checkout, as the map held it when the issue was read. */
  root: string;
  number: number;
  title: string;
  url: string;
  by: string;
  what: StrangerAct;
  at: number;
}

/**
 * An issue Leo marked ready in a project whose `issue-ready` starts a
 * session: what the worker queue (`src/server/worker-queue.ts`) chooses from.
 */
export interface ReadyIssue {
  repo: string;
  root: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  /** How many of its blockers are still open. */
  blockedBy: number;
  /** The `updatedAt` of the copy its readiness was judged on: the queue checks GitHub still has it before claiming. */
  updatedAt: string;
}

export interface BranchState {
  head: string;
  held: boolean;
  /** When this was read from GitHub. */
  readAt: number;
}

export interface PollStatus {
  viewer: string | null;
  lastPollAt: number | null;
  lastError: string | null;
  /** GraphQL points spent in the last hour, and how many queries that took. */
  pointsLastHour: number;
  queriesLastHour: number;
  remaining: number | null;
}

function outcomeOf(event: Pick<SeenEvent, "action" | "kind" | "repo">): string {
  if (event.action !== "rule") return "Queued for a worker";
  return event.kind === "push" && event.repo === RELEASE_REPO ? "Handed to the release rule" : "Recorded as seen";
}

export class EventPoller {
  private file: EventsFile;
  private readonly now: () => number;
  private viewer: string | null = null;
  /** Each issue as last read in full, by `slug#n`. */
  private details = new Map<string, IssueDetail>();
  private approvals = new Map<string, Approval>();
  private ready: ReadyIssue[] = [];
  /** When `ready` was last worked out from an answer. */
  private readyAt: number | null = null;
  private branches = new Map<string, BranchState>();
  private sweepListeners = new Set<() => void>();
  private spent: { at: number; cost: number }[] = [];
  private remaining: number | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? Date.now;
    this.file = deps.store.load();
  }

  start(intervalMs = POLL_MS): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Read GitHub now. A read already under way is not doubled: one more
   * follows it, so a change made meanwhile (a project enabled) is seen.
   */
  poll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.sweep();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  status(): PollStatus {
    const since = this.now() - QUOTA_WINDOW_MS;
    this.spent = this.spent.filter((s) => s.at > since);
    return {
      viewer: this.viewer,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      pointsLastHour: this.spent.reduce((n, s) => n + s.cost, 0),
      queriesLastHour: this.spent.length,
      remaining: this.remaining,
    };
  }

  /** The ready issues whose project starts a session for them, as the last read found them; none when that read is old. */
  readyIssues(): ReadyIssue[] {
    if (this.readyAt === null || this.now() - this.readyAt > READY_MAX_AGE_MS) return [];
    return this.ready;
  }

  /** A project's default branch head and whether a hold is open, as the last read that reached it found them. */
  branch(slug: string): BranchState | null {
    return this.branches.get(slug) ?? null;
  }

  /** Called after every read of GitHub that got an answer. Returns the unsubscribe. */
  onSweep(listener: () => void): () => void {
    this.sweepListeners.add(listener);
    return () => this.sweepListeners.delete(listener);
  }

  log(): SeenEvent[] {
    return this.file.log;
  }

  /** The issues waiting for Leo to approve again, for Needs you. */
  approvalTickets(): InboxTicket[] {
    return [...this.approvals.values()].map((a) => ({
      repo: a.repo,
      git_root: a.root,
      number: a.number,
      title: a.title,
      url: a.url,
      kind: "approve" as const,
      since: a.at,
      note: `${a.by === "someone" ? "Someone" : `@${a.by}`} ${ACT_PHRASE[a.what]} it after it was marked ${READY_LABEL}`,
    }));
  }

  /**
   * Leo's approval: the label taken off and put back under his name, which
   * makes it newer than what the other person did. Then GitHub is read again.
   */
  async approve(repo: string, number: number): Promise<"approved" | "not-waiting" | "refused" | "label-lost"> {
    if (!this.approvals.has(`${repo}#${number}`)) return "not-waiting";
    const base = `repos/${repo}/issues/${number}/labels`;
    const add = () => this.deps.gh(["api", "-X", "POST", base, "-f", `labels[]=${READY_LABEL}`]);
    if (!(await this.deps.gh(["api", "-X", "DELETE", `${base}/${READY_LABEL}`]))) return "refused";
    // The label is off now; one failed add must not leave it so.
    if (!(await add()) && !(await add())) return "label-lost";
    // The read that clears the approval runs on its own and is broadcast when it lands.
    void this.poll();
    return "approved";
  }

  private charge(data: Record<string, unknown>): void {
    const rate = data.rateLimit as RateLimit | undefined;
    // A query GitHub did not price still costs a point.
    this.spent.push({ at: this.now(), cost: rate?.cost ?? 1 });
    if (rate) this.remaining = rate.remaining;
  }

  private record(event: Omit<SeenEvent, "at" | "outcome" | "skipped">): void {
    const seen: SeenEvent = this.deps.on()
      ? { ...event, at: this.now(), outcome: outcomeOf(event) }
      : { ...event, at: this.now(), outcome: MACHINE_OFF, skipped: true };
    this.file.log = [seen, ...this.file.log].slice(0, LOG_LIMIT);
  }

  private async sweep(): Promise<void> {
    const before = this.approvalsKey();
    try {
      // A read that failed keeps the last list, which `readyIssues()` refuses once it is old.
      if (await this.read()) for (const listener of this.sweepListeners) listener();
    } finally {
      if (this.approvalsKey() !== before) this.deps.onApprovals?.();
    }
  }

  private approvalsKey(): string {
    return JSON.stringify([...this.approvals.values()]);
  }

  /** True when GitHub answered, so what it holds is current. */
  private async read(): Promise<boolean> {
    const projects = this.deps.projects();
    // A project turned off forgets where it was: turned on again, its branch
    // head is noted afresh rather than taken for a push.
    for (const slug of Object.keys(this.file.repos)) {
      if (!projects.has(slug)) {
        delete this.file.repos[slug];
        this.branches.delete(slug);
        this.deps.store.save(this.file);
      }
    }
    const slugs = [...projects.keys()];
    // Approvals belong to enabled projects only.
    for (const [key, a] of this.approvals) if (!projects.has(a.repo)) this.approvals.delete(key);
    if (slugs.length === 0) {
      this.setReady([]);
      return true;
    }

    const data = await this.deps.graphql(sweepQuery(slugs));
    this.lastPollAt = this.now();
    if (!data) {
      this.lastError = "GitHub did not answer";
      return false;
    }
    this.charge(data);
    this.lastError = null;
    const viewer = (data.viewer as { login?: string } | undefined)?.login ?? null;
    if (!viewer) {
      this.lastError = "gh is not logged in";
      return false;
    }
    this.viewer = viewer;

    let dirty = false;
    const stale: { slug: string; number: number }[] = [];
    const listed = new Map<string, number[]>();
    const blocked = new Map<string, number>();
    slugs.forEach((slug, i) => {
      const repo = data[`r${i}`] as SweepRepo | null | undefined;
      if (!repo) {
        // Renamed, deleted or out of reach: nothing there can be approved.
        for (const [id, a] of this.approvals) if (a.repo === slug) this.approvals.delete(id);
        this.lastError = `GitHub did not return ${slug}`;
        return;
      }
      const cursor = (this.file.repos[slug] ??= { head: null, seen: [] });
      const numbers: number[] = [];
      for (const issue of repo.issues.nodes) {
        if (!issue) continue;
        numbers.push(issue.number);
        blocked.set(`${slug}#${issue.number}`, issue.issueDependenciesSummary?.blockedBy ?? 0);
        const have = this.details.get(`${slug}#${issue.number}`);
        if (!have || have.updatedAt !== issue.updatedAt) stale.push({ slug, number: issue.number });
      }
      listed.set(slug, numbers);

      const head = repo.defaultBranchRef?.target ?? null;
      if (head) this.branches.set(slug, { head: head.oid, held: (repo.holds?.totalCount ?? 0) > 0, readAt: this.now() });
      if (head && head.oid !== cursor.head) {
        if (cursor.head !== null) {
          const action = projects.get(slug)!.events.push;
          if (action !== "ignore") {
            this.record({
              key: `${slug}@${head.oid}`,
              repo: slug,
              kind: "push",
              action,
              title: `${repo.defaultBranchRef!.name}: ${head.messageHeadline ?? head.oid.slice(0, 7)}`,
              url: `https://github.com/${slug}/commit/${head.oid}`,
            });
          }
        }
        cursor.head = head.oid;
        dirty = true;
      }
    });

    if (stale.length > 0) {
      const detail = await this.deps.graphql(detailQuery(stale));
      if (detail) this.charge(detail);
      stale.forEach(({ slug, number }, i) => {
        const issue = (detail?.[`d${i}`] as { issue?: IssueDetail | null } | null | undefined)?.issue;
        // The old copy predates whatever moved `updatedAt` (a stranger's comment, say), so it is dropped, never judged.
        if (issue) this.details.set(`${slug}#${number}`, issue);
        else this.details.delete(`${slug}#${number}`);
      });
    }

    const ready: ReadyIssue[] = [];
    for (const [slug, numbers] of listed) {
      const cursor = this.file.repos[slug];
      const project = projects.get(slug)!;
      const action = project.events["issue-ready"];
      const keep: string[] = [];
      const open = new Set(numbers);
      for (const key of [...this.details.keys()]) {
        if (key.startsWith(`${slug}#`) && !open.has(Number(key.slice(slug.length + 1)))) this.details.delete(key);
      }
      for (const number of numbers) {
        const issue = this.details.get(`${slug}#${number}`);
        // Not read in full yet (the detail read failed): the next sweep reads it.
        if (!issue) {
          keep.push(...cursor.seen.filter((k) => k.startsWith(`${slug}#${number}@`)));
          continue;
        }
        const readyState = readiness(issue, viewer);
        const id = `${slug}#${number}`;
        if (readyState.state === "approve") {
          this.approvals.set(id, {
            repo: slug,
            root: project.root,
            number,
            title: issue.title,
            url: issue.url,
            by: readyState.by,
            what: readyState.what,
            at: Date.parse(readyState.at),
          });
          continue;
        }
        this.approvals.delete(id);
        if (readyState.state !== "ready") continue;
        if (action === "session") {
          ready.push({
            repo: slug,
            root: project.root,
            number,
            title: issue.title,
            url: issue.url,
            labels: (issue.labels?.nodes ?? []).flatMap((l) => (l ? [l.name] : [])),
            blockedBy: blocked.get(id) ?? 0,
            updatedAt: issue.updatedAt,
          });
        }
        const key = `${id}@${readyState.labeledAt}`;
        // An ignored event is not marked seen, so turning the rule on later finds it.
        if (action === "ignore") continue;
        keep.push(key);
        if (cursor.seen.includes(key)) continue;
        this.record({ key, repo: slug, kind: "issue-ready", action, title: `#${number} ${issue.title}`, url: issue.url });
        dirty = true;
      }
      for (const [id, a] of this.approvals) if (a.repo === slug && !open.has(a.number)) this.approvals.delete(id);
      if (keep.length !== cursor.seen.length || keep.some((k, i) => k !== cursor.seen[i])) dirty = true;
      cursor.seen = keep;
    }

    this.setReady(ready.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number));
    if (dirty) this.deps.store.save(this.file);
    return true;
  }

  private setReady(ready: ReadyIssue[]): void {
    this.ready = ready;
    this.readyAt = this.now();
  }
}

// ── the real thing ───────────────────────────────────────────────────────────

function runGh(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve({ ok: !err, stdout })
    );
  });
}

/**
 * `gh api graphql` exits 1 when any part of the answer is an error (a repo
 * renamed or out of reach), yet still prints the rest; one such project must
 * not blind the read to all the others.
 */
export const ghGraphql: GraphqlRunner = async (query) => {
  const { stdout } = await runGh(["api", "graphql", "-f", `query=${query}`]);
  try {
    return (JSON.parse(stdout) as { data?: Record<string, unknown> | null }).data ?? null;
  } catch {
    return null;
  }
};

// On `globalThis`: under the dev server the routes and the broadcast load this module separately.
const g = globalThis as typeof globalThis & { __claudeMuxEventPoller?: EventPoller };

/** This server's poller, started on first call. */
export function eventPoller(onApprovals?: () => void): EventPoller {
  if (!g.__claudeMuxEventPoller) {
    g.__claudeMuxEventPoller = new EventPoller({
      graphql: ghGraphql,
      gh: async (args) => (await runGh(args)).ok,
      store: fileEventStore(),
      projects: () => enabledProjects(),
      onApprovals,
      on: machineOn,
    });
  }
  return g.__claudeMuxEventPoller;
}

/** Whether a poller exists yet; the broadcast reads approvals only from one that runs. */
export function runningEventPoller(): EventPoller | null {
  return g.__claudeMuxEventPoller ?? null;
}
