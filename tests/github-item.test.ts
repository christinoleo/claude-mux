import { describe, it, expect } from "vitest";
import {
  describeChecks,
  groupChecks,
  parseRefParam,
  readableComments,
  refParam,
  toCheck,
  toGithubItem,
  visibleBody,
  type GithubCheck,
  type RawItem,
} from "../src/github-item.js";

function rawPull(over: Partial<RawItem> = {}): RawItem {
  return {
    __typename: "PullRequest",
    number: 118,
    title: "Dictation goes in at the caret",
    url: "https://github.com/o/r/pull/118",
    body: "Closes #114.",
    state: "OPEN",
    isDraft: false,
    additions: 193,
    deletions: 12,
    changedFiles: 7,
    createdAt: "2026-10-14T14:00:00Z",
    updatedAt: "2026-10-14T15:00:00Z",
    headRefName: "task/114",
    baseRefName: "main",
    author: { login: "leo" },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
    latestReviews: {
      nodes: [
        { state: "APPROVED", submittedAt: "2026-10-14T14:30:00Z", author: { login: "ana" } },
        { state: "CHANGES_REQUESTED", submittedAt: "2026-10-14T14:50:00Z", author: { login: "bo" } },
        { state: "DISMISSED", submittedAt: "2026-10-14T14:55:00Z", author: { login: "cy" } },
      ],
    },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { __typename: "User", login: "dee" } },
        { requestedReviewer: { __typename: "User", login: "Ana" } },
        { requestedReviewer: { __typename: "Team", name: "core" } },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2026-10-14T14:40:00Z",
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://x/1" },
                  { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
                  { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://x/3" },
                  { __typename: "StatusContext", context: "ci/legacy", state: "PENDING", targetUrl: null },
                ],
              },
            },
          },
        },
      ],
    },
    ...over,
  };
}

describe("toGithubItem", () => {
  it("reads a pull request: header, branch, reviews, requests and checks", () => {
    const item = toGithubItem(rawPull(), "o/r", null);
    expect(item).toMatchObject({
      repo: "o/r",
      number: 118,
      kind: "pull",
      state: "open",
      author: "leo",
      labels: [{ name: "bug", color: "d73a4a" }],
      comments: null,
      comments_total: 0,
    });
    expect(item.updated_at).toBe(Date.parse("2026-10-14T15:00:00Z"));
    expect(item.pull).toMatchObject({ base: "main", head: "task/114", additions: 193, deletions: 12, files: 7 });
    // The approval came before the newest commit; the dismissal says nothing.
    expect(item.pull!.reviews).toEqual([
      { author: "ana", verdict: "approved", at: Date.parse("2026-10-14T14:30:00Z"), stale: true },
      { author: "bo", verdict: "changes_requested", at: Date.parse("2026-10-14T14:50:00Z"), stale: false },
    ]);
    // Someone who already reviewed is not still waited on, whatever the case of their login.
    expect(item.pull!.requested).toEqual(["dee", "core"]);
    expect(item.pull!.checks.map((c) => [c.name, c.bucket])).toEqual([
      ["lint", "passing"],
      ["test", "running"],
      ["e2e", "failing"],
      ["ci/legacy", "running"],
    ]);
  });

  it("names the state: draft, merged, closed", () => {
    expect(toGithubItem(rawPull({ isDraft: true }), "o/r", null).state).toBe("draft");
    expect(toGithubItem(rawPull({ state: "MERGED" }), "o/r", null).state).toBe("merged");
    expect(toGithubItem(rawPull({ state: "CLOSED" }), "o/r", null).state).toBe("closed");
  });

  it("reads an issue with no pull request facts, and its comments", () => {
    const item = toGithubItem(
      { __typename: "Issue", number: 120, title: "A GitHub pane", url: "https://github.com/o/r/issues/120", body: null, state: "OPEN", author: null },
      "o/r",
      {
        comments: {
          totalCount: 140,
          nodes: [
            { id: "a", body: "hi", createdAt: "2026-10-14T10:00:00Z", url: "u1", author: { __typename: "User", login: "leo" } },
            { id: "b", body: "report", createdAt: "2026-10-14T11:00:00Z", url: "u2", author: { __typename: "Bot", login: "codecov" } },
            { id: "c", body: "spam", url: "u3", isMinimized: true, author: { login: "x" } },
            { id: "d", body: "gone", url: "u4", author: null },
          ],
        },
      }
    );
    expect(item).toMatchObject({ kind: "issue", state: "open", body: "", author: null, pull: null, comments_total: 140 });
    expect(item.comments!.map((c) => [c.id, c.author, c.bot])).toEqual([
      ["a", "leo", false],
      ["b", "codecov", true],
      ["d", "ghost", false],
    ]);
  });
});

describe("checks", () => {
  const check = (bucket: GithubCheck["bucket"], name = bucket): GithubCheck => ({ name, bucket, status: "", url: null });

  it("words every live facet", () => {
    const list = [...Array(7)].map(() => check("running")).concat([check("failing")], [...Array(8)].map(() => check("passing")));
    expect(describeChecks(list)).toBe("7 of 16 running · 1 failed");
    expect(describeChecks([check("failing"), check("passing")])).toBe("1 failed · 1 of 2 passed");
    expect(describeChecks([check("passing"), check("passing")])).toBe("All 2 passed");
    expect(describeChecks([])).toBe("No checks");
  });

  it("orders them failing, running, passing", () => {
    const g = groupChecks([check("passing", "p"), check("running", "r"), check("failing", "f")]);
    expect([...g.failing, ...g.running, ...g.passing].map((c) => c.name)).toEqual(["f", "r", "p"]);
  });

  it("reads a status context's failure and a run's timeout as failing", () => {
    expect(toCheck({ __typename: "StatusContext", context: "x", state: "ERROR" })?.bucket).toBe("failing");
    expect(toCheck({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "TIMED_OUT" })).toMatchObject({
      bucket: "failing",
      status: "timed out",
    });
    expect(toCheck({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" })?.bucket).toBe("passing");
  });
});

describe("comments", () => {
  it("drops a body of bot markers only", () => {
    expect(visibleBody("<!-- coverage:start -->\n<!-- end -->")).toBe("");
    expect(visibleBody("<!-- x --> Looks good")).toBe("<!-- x --> Looks good");
  });

  it("splits people from bots and leaves out empty ones", () => {
    const c = (id: string, bot: boolean, body = "x") => ({ id, author: id, bot, body, at: null, url: "" });
    const { people, bots } = readableComments([c("a", false), c("b", true), c("c", true, "<!-- m -->"), c("d", false, " ")]);
    expect(people.map((x) => x.id)).toEqual(["a"]);
    expect(bots.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("refParam", () => {
  it("spells and reads owner/name#n", () => {
    expect(refParam("o/r", 12)).toBe("o/r#12");
    expect(parseRefParam("christinoleo/claude-mux#120")).toEqual({ repo: "christinoleo/claude-mux", number: 120 });
    expect(parseRefParam("o/r#0")).toBeNull();
    expect(parseRefParam("o#1")).toBeNull();
    expect(parseRefParam("o/r/x#1")).toBeNull();
    expect(parseRefParam(undefined)).toBeNull();
  });
});
