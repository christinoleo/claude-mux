import { describe, it, expect } from "vitest";
import {
  FAILED_TTL_MS,
  OPEN_TTL_MS,
  SETTLED_TTL_MS,
  createGithubItemReader,
  readHead,
  type GhCall,
  type GhOutput,
} from "../../src/server/github-items.js";

const ok = (out: string): GhOutput => ({ ok: true, out, err: "" });
const fail = (err: string, out = ""): GhOutput => ({ ok: false, out, err });

function issue(state = "OPEN", title = "A pane") {
  return JSON.stringify({
    data: { repository: { issueOrPullRequest: { __typename: "Issue", number: 1, title, url: "u", body: "b", state } } },
  });
}
function pull(running: boolean) {
  return JSON.stringify({
    data: {
      repository: {
        issueOrPullRequest: {
          __typename: "PullRequest",
          number: 1,
          title: "PR",
          url: "u",
          state: "OPEN",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: { nodes: [{ __typename: "CheckRun", name: "t", status: running ? "IN_PROGRESS" : "COMPLETED", conclusion: running ? null : "SUCCESS" }] },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
}
const comments = JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { totalCount: 0, nodes: [] } } } } });
const head = (status: number, etag = 'W/"e1"') => `HTTP/2.0 ${status} X\r\nEtag: ${etag}\r\n\r\n{}`;

/** A fake `gh` that answers by the kind of call and records each. */
function fakeGh(answers: { item?: () => GhOutput; comments?: () => GhOutput; rest?: (args: string[]) => GhOutput }) {
  const calls: string[][] = [];
  const gh: GhCall = async (args) => {
    calls.push(args);
    if (args[1] === "graphql") {
      const query = args.find((a) => a.startsWith("query="))!;
      if (query.includes("comments(")) return (answers.comments ?? (() => ok(comments)))();
      return (answers.item ?? (() => ok(issue())))();
    }
    return (answers.rest ?? (() => ok(head(200))))(args);
  };
  const graphqlCalls = () => calls.filter((c) => c[1] === "graphql").length;
  const restCalls = () => calls.filter((c) => c[1] === "-i");
  return { gh, calls, graphqlCalls, restCalls };
}

describe("readHead", () => {
  it("reads the status and ETag of gh api -i output", () => {
    expect(readHead('HTTP/2.0 304 Not Modified\r\nEtag: "abc"\r\nX: y\r\n\r\n')).toEqual({ status: 304, etag: '"abc"' });
    expect(readHead("HTTP/2.0 200 OK\nContent-Type: x\n\n{\"etag\": \"no\"}")).toEqual({ status: 200, etag: null });
    expect(readHead("garbage")).toBeNull();
  });
});

describe("createGithubItemReader", () => {
  it("reads the item and its comments once, and serves the next ask from the cache", async () => {
    let t = 0;
    const g = fakeGh({});
    const reader = createGithubItemReader(g.gh, () => t);
    const first = await reader.read("o/r", 1);
    expect(first.item?.title).toBe("A pane");
    expect(first.stale).toBe(false);
    expect(g.graphqlCalls()).toBe(2);
    t = OPEN_TTL_MS - 1;
    await reader.read("o/r", 1);
    expect(g.graphqlCalls()).toBe(2);
  });

  it("merges asks that arrive together into one read", async () => {
    const g = fakeGh({});
    const reader = createGithubItemReader(g.gh, () => 0);
    await Promise.all([reader.read("o/r", 1), reader.read("O/R", 1), reader.read("o/r", 1)]);
    expect(g.graphqlCalls()).toBe(2);
  });

  it("keeps a closed item ten minutes, an open one a minute", async () => {
    let t = 0;
    const g = fakeGh({ item: () => ok(issue("CLOSED")), rest: () => ok(head(200, '"e2"')) });
    const reader = createGithubItemReader(g.gh, () => t);
    await reader.read("o/r", 1);
    t = OPEN_TTL_MS + 1;
    await reader.read("o/r", 1);
    expect(g.graphqlCalls()).toBe(2);
    t = SETTLED_TTL_MS + 1;
    await reader.read("o/r", 1);
    expect(g.restCalls().length).toBe(2);
  });

  it("asks with the ETag once expired, and a 304 reads nothing more", async () => {
    let t = 0;
    let status = 304;
    const g = fakeGh({ rest: (args) => (args.includes("If-None-Match: W/\"e1\"") ? fail("gh: HTTP 304", head(status)) : ok(head(200))) });
    const reader = createGithubItemReader(g.gh, () => t);
    await reader.read("o/r", 1);
    expect(g.restCalls().length).toBe(1);
    t = OPEN_TTL_MS + 1;
    const again = await reader.read("o/r", 1);
    expect(again.item?.title).toBe("A pane");
    expect(g.graphqlCalls()).toBe(2);
    expect(g.restCalls()[1]).toContain('If-None-Match: W/"e1"');
    // The 304 stood for another minute; once GitHub says it changed, it is read again.
    status = 200;
    t = 2 * OPEN_TTL_MS + 2;
    await reader.read("o/r", 1);
    expect(g.graphqlCalls()).toBe(4);
  });

  it("reads a pull request whose checks are running in full, since its ETag misses them", async () => {
    let t = 0;
    const g = fakeGh({ item: () => ok(pull(true)), rest: () => fail("gh: HTTP 304", head(304)) });
    const reader = createGithubItemReader(g.gh, () => t);
    await reader.read("o/r", 1);
    t = OPEN_TTL_MS + 1;
    await reader.read("o/r", 1);
    expect(g.graphqlCalls()).toBe(4);
    expect(g.restCalls().length).toBe(1);
  });

  it("serves the last good answer, marked stale, when a refresh fails", async () => {
    let t = 0;
    let answer = () => ok(issue());
    const g = fakeGh({ item: () => answer(), rest: () => ok(head(200, '"new"')) });
    const reader = createGithubItemReader(g.gh, () => t);
    await reader.read("o/r", 1);
    answer = () => fail("GraphQL: API rate limit exceeded");
    t = OPEN_TTL_MS + 1;
    const stale = await reader.read("o/r", 1);
    expect(stale).toMatchObject({ stale: true, item: { title: "A pane" } });
    // It is tried again soon, not a minute later.
    answer = () => ok(issue("OPEN", "Renamed"));
    t += FAILED_TTL_MS + 1;
    expect((await reader.read("o/r", 1)).item?.title).toBe("Renamed");
  });

  it("keeps the last comments when only their read fails", async () => {
    let t = 0;
    let talk = () =>
      ok(JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { totalCount: 1, nodes: [{ id: "a", body: "hi", url: "u" }] } } } } }));
    const g = fakeGh({ comments: () => talk(), rest: () => ok(head(200, '"x"')) });
    const reader = createGithubItemReader(g.gh, () => t);
    await reader.read("o/r", 1);
    talk = () => fail("timeout");
    t = OPEN_TTL_MS + 1;
    const again = await reader.read("o/r", 1);
    expect(again.item?.comments?.map((c) => c.id)).toEqual(["a"]);
  });

  it("says when gh is logged out or the item does not exist", async () => {
    const out = createGithubItemReader(fakeGh({ item: () => fail("To get started with GitHub CLI, please run:  gh auth login") }).gh, () => 0);
    expect(await out.read("o/r", 1)).toEqual({ item: null, error: "no-gh" });
    const none = createGithubItemReader(fakeGh({ item: () => fail("gh: Could not resolve to an issue or pull request") }).gh, () => 0);
    expect(await none.read("o/r", 1)).toEqual({ item: null, error: "not-found" });
    const missing = createGithubItemReader(async () => ({ ok: false, out: "", err: "", missing: true }), () => 0);
    expect((await missing.read("o/r", 1)).error).toBe("no-gh");
  });

  it("asks nothing for a repo or number that is not one", async () => {
    const g = fakeGh({});
    const reader = createGithubItemReader(g.gh, () => 0);
    expect((await reader.read("../x", 1)).error).toBe("not-found");
    expect((await reader.read("o/r", 0)).error).toBe("not-found");
    expect(g.calls).toEqual([]);
  });

  it("finds a branch's pull request and keeps the answer a minute", async () => {
    const t = 0;
    const calls: string[][] = [];
    const reader = createGithubItemReader(async (args) => {
      calls.push(args);
      return ok(JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ number: 118 }] } } } }));
    }, () => t);
    expect(await reader.branchPull("o/r", "task/114")).toBe(118);
    expect(calls[0]).toContain("branch=task/114");
    await reader.branchPull("o/r", "task/114");
    expect(calls.length).toBe(1);
  });
});
