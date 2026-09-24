import { describe, it, expect } from "vitest";
import { ticketsFromIssues, toIssueInfo, firstParagraph, type RawIssue } from "../../src/server/github.js";

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
