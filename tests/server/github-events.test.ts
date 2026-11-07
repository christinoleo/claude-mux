import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EventPoller,
  POLL_MS,
  READY_MAX_AGE_MS,
  fileEventStore,
  readiness,
  type EventsFile,
  type EventStore,
  type IssueDetail,
  type TimelineNode,
} from "../../src/server/github-events.js";
import {
  enabledProjects,
  eventProjectRows,
  getEventMap,
  setEventMapPath,
  updateProjectEvents,
} from "../../src/db/event-map-json.js";

const LEO = { __typename: "User", login: "christinoleo" };
const STRANGER = { __typename: "User", login: "stranger" };
const BOT = { __typename: "Bot", login: "github-actions" };

function labeled(at: string, actor = LEO, name = "ready-for-agent"): TimelineNode {
  return { __typename: "LabeledEvent", createdAt: at, label: { name }, actor };
}

function detail(number: number, nodes: TimelineNode[], edits: IssueDetail["userContentEdits"] = null, updatedAt = "u1"): IssueDetail {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    updatedAt,
    timelineItems: { nodes },
    userContentEdits: edits,
  };
}

describe("readiness", () => {
  it("is ready when Leo applied the label and nobody else acted after", () => {
    const r = readiness(
      detail(1, [
        { __typename: "IssueComment", createdAt: "2026-11-01T00:00:00Z", author: STRANGER },
        labeled("2026-11-02T00:00:00Z"),
      ]),
      "christinoleo"
    );
    expect(r).toEqual({ state: "ready", labeledAt: "2026-11-02T00:00:00Z" });
  });

  it("is not ready when someone else applied the label", () => {
    const r = readiness(detail(1, [labeled("2026-11-02T00:00:00Z", STRANGER)]), "christinoleo");
    expect(r).toMatchObject({ state: "approve", by: "stranger", what: "labelled" });
  });

  it("asks again when someone else edited, commented or renamed it after the label", () => {
    const after = "2026-11-03T00:00:00Z";
    const base = [labeled("2026-11-02T00:00:00Z")];
    const cases: [IssueDetail, string][] = [
      [detail(1, base, { nodes: [{ editedAt: after, editor: STRANGER }] }), "edited"],
      [detail(1, [...base, { __typename: "IssueComment", createdAt: after, author: STRANGER }]), "commented"],
      [detail(1, [...base, { __typename: "RenamedTitleEvent", createdAt: after, actor: STRANGER }]), "renamed"],
      [
        detail(1, [
          { __typename: "IssueComment", createdAt: "2026-11-01T00:00:00Z", author: STRANGER, lastEditedAt: after, editor: STRANGER },
          ...base,
        ]),
        "edited",
      ],
    ];
    for (const [issue, what] of cases) {
      expect(readiness(issue, "christinoleo")).toMatchObject({ state: "approve", by: "stranger", what, at: after });
    }
  });

  it("does not take a Bot's word for Leo's: a stranger can set one off", () => {
    const r = readiness(
      detail(1, [labeled("2026-11-02T00:00:00Z"), { __typename: "IssueComment", createdAt: "2026-11-03T00:00:00Z", author: BOT }]),
      "christinoleo"
    );
    expect(r).toMatchObject({ state: "approve", by: "github-actions", what: "commented" });
  });

  it("lets Leo's own edits pass, and his agents', which act under his token", () => {
    const after = "2026-11-03T00:00:00Z";
    const r = readiness(
      detail(
        1,
        [
          labeled("2026-11-02T00:00:00Z"),
          { __typename: "IssueComment", createdAt: after, author: LEO },
          { __typename: "RenamedTitleEvent", createdAt: after, actor: { __typename: "User", login: "ChristinoLeo" } },
        ],
        { nodes: [{ editedAt: after, editor: LEO }] }
      ),
      "christinoleo"
    );
    expect(r.state).toBe("ready");
  });

  it("takes the latest label: Leo labelling again after the edit makes it ready", () => {
    const r = readiness(
      detail(1, [
        labeled("2026-11-02T00:00:00Z"),
        { __typename: "IssueComment", createdAt: "2026-11-03T00:00:00Z", author: STRANGER },
        labeled("2026-11-04T00:00:00Z"),
      ]),
      "christinoleo"
    );
    expect(r).toEqual({ state: "ready", labeledAt: "2026-11-04T00:00:00Z" });
  });

  it("asks again when someone else took a label off after the ready label", () => {
    const r = readiness(
      detail(1, [
        labeled("2026-11-02T00:00:00Z"),
        { __typename: "UnlabeledEvent", createdAt: "2026-11-03T00:00:00Z", label: { name: "hold" }, actor: STRANGER },
      ]),
      "christinoleo"
    );
    expect(r).toMatchObject({ state: "approve", by: "stranger", what: "unlabelled" });
    const own = readiness(
      detail(1, [
        labeled("2026-11-02T00:00:00Z"),
        { __typename: "UnlabeledEvent", createdAt: "2026-11-03T00:00:00Z", label: { name: "hold" }, actor: LEO },
      ]),
      "christinoleo"
    );
    expect(own.state).toBe("ready");
  });

  it("counts a deleted account as someone else", () => {
    const r = readiness(
      detail(1, [labeled("2026-11-02T00:00:00Z"), { __typename: "IssueComment", createdAt: "2026-11-03T00:00:00Z", author: null }]),
      "christinoleo"
    );
    expect(r).toMatchObject({ state: "approve", by: "someone" });
  });
});

/** A fake GitHub: per repo a head and the ready issues, each with its full detail. */
class FakeGithub {
  repos = new Map<string, { head: string; issues: IssueDetail[]; holds?: number }>();
  queries: string[] = [];
  down = false;
  /** The detail query fails while this is set. */
  detailDown = false;
  labelCalls: string[][] = [];

  graphql = async (query: string): Promise<Record<string, unknown> | null> => {
    this.queries.push(query);
    if (this.down) return null;
    if (this.detailDown && /\bd0:/.test(query)) return null;
    const data: Record<string, unknown> = { rateLimit: { cost: 1, remaining: 4999, resetAt: "" }, viewer: { login: "christinoleo" } };
    for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
      const repo = this.repos.get(`${m[2]}/${m[3]}`);
      data[m[1]] = repo
        ? {
            nameWithOwner: `${m[2]}/${m[3]}`,
            defaultBranchRef: { name: "main", target: { oid: repo.head, messageHeadline: `commit ${repo.head}` } },
            holds: { totalCount: repo.holds ?? 0 },
            issues: {
              nodes: repo.issues.map((i) => ({
                number: i.number,
                updatedAt: i.updatedAt,
                issueDependenciesSummary: { blockedBy: this.blocked.get(i.number) ?? 0 },
              })),
            },
          }
        : null;
    }
    for (const m of query.matchAll(/(d\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{\s*issue\(number: (\d+)\)/g)) {
      const issue = this.repos.get(`${m[2]}/${m[3]}`)?.issues.find((i) => i.number === Number(m[4]));
      data[m[1]] = { issue: issue ?? null };
    }
    return data;
  };

  /** Open blockers by issue number. */
  blocked = new Map<number, number>();

  gh = async (args: string[]): Promise<boolean> => {
    this.labelCalls.push(args);
    return true;
  };
}

function memoryStore(): EventStore & { file: EventsFile | null } {
  return {
    file: null,
    load() {
      return this.file ? structuredClone(this.file) : { v: 1, repos: {}, log: [] };
    },
    save(file) {
      this.file = structuredClone(file);
    },
  };
}

describe("EventPoller", () => {
  let dir: string;
  let gh: FakeGithub;
  let store: ReturnType<typeof memoryStore>;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "events-"));
    setEventMapPath(join(dir, "event-map.json"));
    gh = new FakeGithub();
    gh.repos.set("o/r", { head: "a1", issues: [] });
    store = memoryStore();
    now = Date.parse("2026-11-07T12:00:00Z");
  });

  afterEach(() => {
    setEventMapPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function poller(): EventPoller {
    return new EventPoller({ graphql: gh.graphql, gh: gh.gh, store, projects: () => enabledProjects(), now: () => now });
  }

  it("reads nothing for a project until it is enabled, then records its ready issue as seen", async () => {
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    const p = poller();
    await p.poll();
    expect(gh.queries).toEqual([]);
    expect(eventProjectRows([{ root: "/p/r", remote: "github.com/o/r", sub: "" }])).toMatchObject([
      { repo: "o/r", enabled: false },
    ]);

    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    await p.poll();
    expect(p.log()).toMatchObject([{ kind: "issue-ready", repo: "o/r", title: "#5 Issue 5", outcome: "Recorded as seen" }]);

    // The same label is one event, however often it is read.
    now += POLL_MS;
    await p.poll();
    expect(p.log()).toHaveLength(1);
  });

  it("records an event seen while the machine's switch is off as off, and still reads it", async () => {
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = new EventPoller({ graphql: gh.graphql, gh: gh.gh, store, projects: () => enabledProjects(), now: () => now, on: () => false });
    await p.poll();
    expect(p.log()).toMatchObject([{ kind: "issue-ready", repo: "o/r", outcome: "Off on this machine" }]);
  });

  it("hands the worker queue the ready issues of projects that start a session, with labels and blockers", async () => {
    const issue = detail(5, [labeled("2026-11-07T11:00:00Z")]);
    issue.labels = { nodes: [{ name: "ready-for-agent" }, { name: "stop-at-pr" }] };
    gh.repos.get("o/r")!.issues = [issue, detail(6, [labeled("2026-11-07T11:00:00Z", STRANGER)])];
    gh.blocked.set(5, 1);
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = poller();
    let sweeps = 0;
    p.onSweep(() => sweeps++);
    await p.poll();
    // The rule only records it.
    expect(p.readyIssues()).toEqual([]);
    expect(sweeps).toBe(1);

    updateProjectEvents("o/r", { events: { "issue-ready": "session" } });
    now += POLL_MS;
    await p.poll();
    expect(p.readyIssues()).toEqual([
      {
        repo: "o/r",
        root: "/p/r",
        number: 5,
        title: "Issue 5",
        url: "https://github.com/o/r/issues/5",
        labels: ["ready-for-agent", "stop-at-pr"],
        blockedBy: 1,
        updatedAt: issue.updatedAt,
      },
    ]);
    // A stranger's label never reaches the queue.
    expect(p.readyIssues().some((i) => i.number === 6)).toBe(false);
  });

  it("asks for label removals in the detail query", async () => {
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    await poller().poll();
    expect(gh.queries.at(-1)).toContain("UNLABELED_EVENT");
    expect(gh.queries.at(-1)).toContain("... on UnlabeledEvent");
  });

  it("drops an issue whose full read failed after its updatedAt moved, rather than judge the old copy", async () => {
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    updateProjectEvents("o/r", { enabled: true, root: "/p/r", events: { "issue-ready": "session" } });
    const p = poller();
    await p.poll();
    expect(p.readyIssues().map((i) => i.number)).toEqual([5]);

    // A stranger comments; the sweep sees updatedAt move, but the full read fails.
    const issue = gh.repos.get("o/r")!.issues[0];
    gh.repos.get("o/r")!.issues = [
      {
        ...issue,
        updatedAt: "u2",
        timelineItems: { nodes: [...issue.timelineItems.nodes, { __typename: "IssueComment", createdAt: "2026-11-07T11:30:00Z", author: STRANGER }] },
      },
    ];
    gh.detailDown = true;
    now += POLL_MS;
    await p.poll();
    expect(p.readyIssues()).toEqual([]);

    gh.detailDown = false;
    now += POLL_MS;
    await p.poll();
    expect(p.readyIssues()).toEqual([]);
    expect(p.approvalTickets()).toMatchObject([{ number: 5 }]);
  });

  it("refuses a ready list gone old while reads fail, and keeps it through one failure", async () => {
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    updateProjectEvents("o/r", { enabled: true, root: "/p/r", events: { "issue-ready": "session" } });
    const p = poller();
    await p.poll();
    expect(p.readyIssues()).toHaveLength(1);

    // One failure is not worth emptying the queue (and forgetting how long each issue waited)...
    gh.down = true;
    now += POLL_MS;
    await p.poll();
    expect(p.readyIssues()).toHaveLength(1);
    // ...but a list no read has confirmed for a while is not trusted.
    now += READY_MAX_AGE_MS;
    await p.poll();
    expect(p.readyIssues()).toEqual([]);

    gh.down = false;
    await p.poll();
    expect(p.readyIssues()).toHaveLength(1);
  });

  it("records nothing for an event the map ignores, and finds it when the rule is turned on", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r", events: { "issue-ready": "ignore" } });
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    const p = poller();
    await p.poll();
    expect(p.log()).toEqual([]);
    updateProjectEvents("o/r", { events: { "issue-ready": "rule" } });
    await p.poll();
    expect(p.log()).toHaveLength(1);
  });

  it("holds an issue someone else edited after the label for approval, and approves it by labelling again", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const edited = detail(5, [labeled("2026-11-07T11:00:00Z")], { nodes: [{ editedAt: "2026-11-07T11:30:00Z", editor: STRANGER }] });
    gh.repos.get("o/r")!.issues = [edited];
    const p = poller();
    await p.poll();
    expect(p.log()).toEqual([]);
    expect(p.approvalTickets()).toMatchObject([{ kind: "approve", repo: "o/r", number: 5, git_root: "/p/r" }]);

    // Leo approves: the label comes off and goes back on under his name.
    gh.gh = async (args) => {
      gh.labelCalls.push(args);
      if (args.includes("POST")) {
        gh.repos.get("o/r")!.issues = [
          { ...edited, updatedAt: "u2", timelineItems: { nodes: [...edited.timelineItems.nodes, labeled("2026-11-07T12:00:00Z")] } },
        ];
      }
      return true;
    };
    const approver = new EventPoller({ graphql: gh.graphql, gh: (a) => gh.gh(a), store, projects: () => enabledProjects(), now: () => now });
    await approver.poll();
    expect(await approver.approve("o/r", 5)).toBe("approved");
    await approver.poll();
    expect(gh.labelCalls.map((a) => a.slice(0, 3))).toEqual([
      ["api", "-X", "DELETE"],
      ["api", "-X", "POST"],
    ]);
    expect(approver.approvalTickets()).toEqual([]);
    expect(approver.log()).toMatchObject([{ kind: "issue-ready", title: "#5 Issue 5" }]);
  });

  it("will not relabel an issue that is not waiting for approval", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = poller();
    await p.poll();
    expect(await p.approve("o/r", 9)).toBe("not-waiting");
    expect(gh.labelCalls).toEqual([]);
  });

  it("puts the label back when the first try fails, and says so when it cannot", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z", STRANGER)])];
    let adds = 0;
    const calls: string[] = [];
    const p = new EventPoller({
      graphql: gh.graphql,
      gh: async (args) => {
        calls.push(args[2]);
        return args[2] === "DELETE" || ++adds > 1;
      },
      store,
      projects: () => enabledProjects(),
    });
    await p.poll();
    expect(await p.approve("o/r", 5)).toBe("approved");
    expect(calls).toEqual(["DELETE", "POST", "POST"]);

    const never = new EventPoller({
      graphql: gh.graphql,
      gh: async (args) => args[2] === "DELETE",
      store,
      projects: () => enabledProjects(),
    });
    await never.poll();
    expect(await never.approve("o/r", 5)).toBe("label-lost");
  });

  it("tells its listener when the issues waiting for approval change, and only then", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    let told = 0;
    const p = new EventPoller({ graphql: gh.graphql, gh: gh.gh, store, projects: () => enabledProjects(), onApprovals: () => told++ });
    await p.poll();
    expect(told).toBe(0);
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z", STRANGER)])];
    await p.poll();
    await p.poll();
    expect(told).toBe(1);
    gh.repos.get("o/r")!.issues = [];
    await p.poll();
    expect(told).toBe(2);
  });

  it("drops an approval for a repo GitHub no longer returns", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z", STRANGER)])];
    const p = poller();
    await p.poll();
    expect(p.approvalTickets()).toHaveLength(1);
    gh.repos.delete("o/r");
    await p.poll();
    expect(p.approvalTickets()).toEqual([]);
    expect(p.status().lastError).toBe("GitHub did not return o/r");
  });

  it("notes the head afresh when a project is turned on again, rather than taking it for a push", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = poller();
    await p.poll();
    updateProjectEvents("o/r", { enabled: false });
    await p.poll();
    gh.repos.get("o/r")!.head = "b2";
    updateProjectEvents("o/r", { enabled: true });
    await p.poll();
    expect(p.log()).toEqual([]);
  });

  it("notes the branch head on the first read and records a push when it moves", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = poller();
    await p.poll();
    expect(p.log()).toEqual([]);
    gh.repos.get("o/r")!.head = "b2";
    await p.poll();
    expect(p.log()).toMatchObject([{ kind: "push", key: "o/r@b2", title: "main: commit b2" }]);
  });

  it("hands the release rule the branch head and whether a release-hold is open", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = poller();
    expect(p.branch("o/r")).toBeNull();
    await p.poll();
    expect(gh.queries[0]).toContain('holds: issues(states: OPEN, labels: ["release-hold"]) { totalCount }');
    expect(p.branch("o/r")).toEqual({ head: "a1", held: false, readAt: now });
    gh.repos.get("o/r")!.holds = 1;
    gh.repos.get("o/r")!.head = "b2";
    now += POLL_MS;
    await p.poll();
    // When it was read rides along, so the rule can tell a read that stopped coming.
    expect(p.branch("o/r")).toEqual({ head: "b2", held: true, readAt: now });
    updateProjectEvents("o/r", { enabled: false });
    await p.poll();
    expect(p.branch("o/r")).toBeNull();
  });

  it("finds an event lost to a failed read on the next one", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const p = poller();
    await p.poll();
    gh.down = true;
    gh.repos.get("o/r")!.head = "b2";
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    await p.poll();
    expect(p.status().lastError).toBe("GitHub did not answer");
    expect(p.log()).toEqual([]);
    gh.down = false;
    await p.poll();
    expect(p.log().map((e) => e.kind).sort()).toEqual(["issue-ready", "push"]);
  });

  it("finds an event that happened while the server was down, and fires nothing twice after a restart", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    await poller().poll();
    expect(store.file!.log).toHaveLength(1);

    // Down: a push lands, and the same issue stays ready.
    gh.repos.get("o/r")!.head = "b2";
    const after = poller();
    await after.poll();
    expect(after.log().map((e) => e.kind)).toEqual(["push", "issue-ready"]);
  });

  it("keeps what it saw on disk", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    const file = fileEventStore(join(dir, "events.json"));
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z")])];
    await new EventPoller({ graphql: gh.graphql, gh: gh.gh, store: file, projects: () => enabledProjects() }).poll();
    expect(file.load().log).toHaveLength(1);
    expect(file.load().repos["o/r"]).toEqual({ head: "a1", seen: ["o/r#5@2026-11-07T11:00:00Z"] });
  });

  it("spends one query, one point, a minute in steady state, however many projects are on", async () => {
    for (const name of ["a", "b", "c"]) {
      gh.repos.set(`o/${name}`, { head: "h", issues: [detail(1, [labeled("2026-11-07T11:00:00Z")])] });
      updateProjectEvents(`o/${name}`, { enabled: true, root: `/p/${name}` });
    }
    const p = poller();
    // The first read also reads the three ready issues in full, in one more query.
    await p.poll();
    expect(gh.queries).toHaveLength(2);
    for (let minute = 1; minute <= 10; minute++) {
      now += POLL_MS;
      await p.poll();
    }
    expect(gh.queries).toHaveLength(12);
    expect(p.status()).toMatchObject({ pointsLastHour: 12, queriesLastHour: 12 });

    // An issue that changes is read again, once.
    const b = gh.repos.get("o/b")!;
    b.issues = [{ ...b.issues[0], updatedAt: "u2" }];
    now += POLL_MS;
    await p.poll();
    expect(gh.queries).toHaveLength(14);
    expect(gh.queries.at(-1)).toContain('d0: repository(owner: "o", name: "b")');

    // Only the last hour counts.
    now += 61 * 60_000;
    expect(p.status().pointsLastHour).toBe(0);
  });

  it("drops what it held for a project that is turned off", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r" });
    gh.repos.get("o/r")!.issues = [detail(5, [labeled("2026-11-07T11:00:00Z", STRANGER)])];
    const p = poller();
    await p.poll();
    expect(p.approvalTickets()).toHaveLength(1);
    updateProjectEvents("o/r", { enabled: false });
    await p.poll();
    expect(p.approvalTickets()).toEqual([]);
  });
});

describe("the state map", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "event-map-"));
    setEventMapPath(join(dir, "event-map.json"));
  });
  afterEach(() => {
    setEventMapPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists each GitHub repo once, at its main checkout, off at first", () => {
    const rows = eventProjectRows([
      { root: "/p/r/.worktree/12", remote: "github.com/o/r", sub: "" },
      { root: "/p/r", remote: "github.com/o/r", sub: "" },
      { root: "/p/r/web", remote: "github.com/o/r", sub: "web" },
      { root: "/p/g", remote: "gitlab.com/o/g", sub: "" },
      { root: "/p/none", remote: null, sub: "" },
    ]);
    expect(rows).toEqual([{ repo: "o/r", root: "/p/r", enabled: false, events: { "issue-ready": "rule", push: "rule" } }]);
  });

  it("names the checkout where it is now, though the map kept an older one", () => {
    updateProjectEvents("o/r", { enabled: true, root: "/old/r" });
    expect(eventProjectRows([{ root: "/new/r", remote: "github.com/o/r", sub: "" }])[0]).toMatchObject({ root: "/new/r", enabled: true });
  });

  it("keeps what each project does, and a torn file turns everything off", async () => {
    updateProjectEvents("o/r", { enabled: true, root: "/p/r", events: { push: "ignore" } });
    expect(getEventMap().projects["o/r"]).toEqual({ enabled: true, root: "/p/r", events: { "issue-ready": "rule", push: "ignore" } });
    const { writeFileSync } = await import("fs");
    writeFileSync(join(dir, "event-map.json"), "{ torn");
    expect(enabledProjects().size).toBe(0);
    // ...and is not written over, which would lose every project it held.
    expect(() => updateProjectEvents("o/x", { enabled: true, root: "/p/x" })).toThrow(/cannot be read/);
  });
});
