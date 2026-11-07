import { describe, it, expect } from "vitest";
import { ticketsFromIssues, closedIssues, toIssueInfo, firstParagraph, withLiveAsker, type RawIssue } from "../../src/server/github.js";

function issue(over: Partial<RawIssue> & { number: number }): RawIssue {
  return {
    title: `Issue ${over.number}`,
    state: "open",
    html_url: `https://github.com/o/r/issues/${over.number}`,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    labels: [],
    assignees: [],
    ...over,
  };
}

describe("ticketsFromIssues", () => {
  it("picks a maestro worker's call for help, dated by its last update", () => {
    const [t] = ticketsFromIssues([issue({ number: 7, labels: [{ name: "in-progress" }, { name: "needs-help" }] })], "o/r", "/repo");
    expect(t).toMatchObject({ kind: "needs-help", number: 7, repo: "o/r", git_root: "/repo" });
    expect(t.since).toBe(Date.parse("2026-09-02T00:00:00Z"));
  });

  it("offers wayfinder tickets only a person resolves, when on the frontier", () => {
    const tickets = ticketsFromIssues(
      [
        issue({ number: 1, labels: [{ name: "wayfinder:grilling" }] }),
        issue({ number: 2, labels: [{ name: "wayfinder:prototype" }] }),
        issue({ number: 3, labels: [{ name: "wayfinder:research" }] }),
        issue({ number: 4, labels: [{ name: "wayfinder:grilling" }], assignees: [{ login: "leo" }] }),
        issue({ number: 5, labels: [{ name: "wayfinder:grilling" }], issue_dependencies_summary: { blocked_by: 1 } }),
        issue({ number: 6, labels: [{ name: "wayfinder:map" }] }),
      ],
      "o/r",
      "/repo"
    );
    expect(tickets.map((t) => [t.number, t.kind])).toEqual([
      [1, "grilling"],
      [2, "prototype"],
    ]);
  });

  it("leaves out anything on hold, the daemon's label for someone else's task", () => {
    const tickets = ticketsFromIssues(
      [
        issue({ number: 1, labels: [{ name: "needs-help" }, { name: "hold" }] }),
        issue({ number: 2, labels: [{ name: "wayfinder:grilling" }, { name: "hold" }] }),
      ],
      "o/r",
      "/repo"
    );
    expect(tickets).toEqual([]);
  });

  it("skips pull requests and closed issues", () => {
    const tickets = ticketsFromIssues(
      [
        issue({ number: 1, labels: [{ name: "needs-help" }], pull_request: {} }),
        issue({ number: 2, labels: [{ name: "needs-help" }], state: "closed" }),
      ],
      "o/r",
      "/repo"
    );
    expect(tickets).toEqual([]);
  });
});

describe("a pull request left for review", () => {
  const stopAtPr = issue({ number: 12, labels: [{ name: "in-progress" }, { name: "stop-at-pr" }] });
  const pr = (over: Partial<RawIssue> = {}) =>
    issue({
      number: 30,
      title: "Fix the thing",
      html_url: "https://github.com/o/r/pull/30",
      created_at: "2026-09-05T00:00:00Z",
      body: "Closes #12. Fixes the thing.",
      pull_request: {},
      ...over,
    });
  const prs = (issues: RawIssue[]) => ticketsFromIssues(issues, "o/r", "/repo").filter((t) => t.kind === "pr");

  it("appears while it is open and closes a stop-at-pr issue, dated by when it was opened", () => {
    const [t] = prs([stopAtPr, pr()]);
    expect(t).toMatchObject({ kind: "pr", number: 30, title: "Fix the thing", repo: "o/r", url: "https://github.com/o/r/pull/30" });
    expect(t.since).toBe(Date.parse("2026-09-05T00:00:00Z"));
  });

  it("leaves once it merges or closes, since only open ones are listed", () => {
    expect(prs([stopAtPr, pr()])).toHaveLength(1);
    // Merged: the PR leaves the open list and the merge closes its issue.
    expect(prs([])).toEqual([]);
    // Closed unmerged: the PR leaves the open list, the issue stays open.
    expect(prs([stopAtPr])).toEqual([]);
    expect(prs([stopAtPr, pr({ state: "closed" })])).toEqual([]);
  });

  it("is not listed for an issue a worker merges itself, or one on hold", () => {
    expect(prs([issue({ number: 12, labels: [{ name: "in-progress" }] }), pr()])).toEqual([]);
    expect(prs([issue({ number: 12, labels: [{ name: "stop-at-pr" }, { name: "hold" }] }), pr()])).toEqual([]);
    expect(prs([stopAtPr, pr({ labels: [{ name: "hold" }] })])).toEqual([]);
    expect(prs([stopAtPr, pr({ body: "Part of #12" })])).toEqual([]);
    expect(prs([stopAtPr, pr({ draft: true })])).toEqual([]);
  });
});

describe("closedIssues", () => {
  it("reads GitHub's closing keywords, in this repo only", () => {
    expect(closedIssues("Closes #12. Also fixes: #13, resolved o/r#14 and fixes x/y#15", "o/r")).toEqual([12, 13, 14]);
    expect(closedIssues("Resolves https://github.com/o/r/issues/16, fixes https://github.com/x/y/issues/17", "o/r")).toEqual([16]);
    expect(closedIssues("Part of #12, see #13", "o/r")).toEqual([]);
    expect(closedIssues(null, "o/r")).toEqual([]);
  });
});

describe("toIssueInfo", () => {
  it("keeps the label names and the page url", () => {
    expect(toIssueInfo(issue({ number: 9, labels: [{ name: "ready" }, "odd"] }))).toEqual({
      number: 9,
      title: "Issue 9",
      state: "open",
      labels: ["ready", "odd"],
      url: "https://github.com/o/r/issues/9",
    });
  });
});

describe("firstParagraph", () => {
  it("flattens the first paragraph of a comment to one line", () => {
    expect(firstParagraph("Need a call on\nthe migration.\n\nDetails below.")).toBe("Need a call on the migration.");
  });
});

describe("withLiveAsker", () => {
  // The two issues autoDS parked under needs-help on 2026-09-20, with no worker.
  const tickets = ticketsFromIssues(
    [
      issue({ number: 104, labels: [{ name: "wayfinder:task" }, { name: "needs-help" }] }),
      issue({ number: 105, labels: [{ name: "wayfinder:task" }, { name: "needs-help" }] }),
      issue({ number: 7, labels: [{ name: "wayfinder:grilling" }] }),
    ],
    "o/r",
    "/repo"
  );

  it("drops a needs-help whose worker is gone, and keeps one whose worker waits", () => {
    const kept = withLiveAsker(tickets, new Set(["/repo#105"]));
    expect(kept.map((t) => t.number)).toEqual([105, 7]);
  });

  it("never filters wayfinder tickets, which have no worker by design", () => {
    expect(withLiveAsker(tickets, new Set()).map((t) => t.number)).toEqual([7]);
  });

  it("lists a ticket once when workers in worktrees have the repo read once per checkout", () => {
    const raw = [
      issue({ number: 105, labels: [{ name: "wayfinder:task" }, { name: "needs-help" }] }),
      issue({ number: 7, labels: [{ name: "wayfinder:grilling" }] }),
    ];
    const all = [
      ...ticketsFromIssues(raw, "o/r", "/repo/.worktree/105"),
      ...ticketsFromIssues(raw, "o/r", "/repo"),
      ...ticketsFromIssues(raw, "o/r", "/repo/.worktree/103"),
    ];
    const kept = withLiveAsker(all, new Set(["/repo/.worktree/105#105"]));
    expect(kept.map((t) => [t.number, t.git_root])).toEqual([
      [105, "/repo/.worktree/105"],
      [7, "/repo"],
    ]);
  });
});
