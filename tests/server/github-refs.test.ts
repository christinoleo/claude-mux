import { describe, it, expect } from "vitest";
import { createGithubRefReader, toGithubRef, type GhResult, type RawRef } from "../../src/server/github-refs.js";

function raw(over: Partial<RawRef> = {}): RawRef {
  return {
    number: 72,
    title: "A file path opens the file",
    state: "open",
    html_url: "https://github.com/o/r/pull/72",
    updated_at: "2026-10-13T16:43:58Z",
    user: { login: "leo" },
    ...over,
  };
}

describe("toGithubRef", () => {
  it("reads an issue", () => {
    expect(toGithubRef(raw({ html_url: "https://github.com/o/r/issues/72" }), "o/r")).toEqual({
      repo: "o/r",
      number: 72,
      kind: "issue",
      title: "A file path opens the file",
      state: "open",
      draft: false,
      author: "leo",
      updated_at: Date.parse("2026-10-13T16:43:58Z"),
      url: "https://github.com/o/r/issues/72",
    });
    expect(toGithubRef(raw({ state: "closed" }), "o/r").state).toBe("closed");
  });

  it("tells a pull request's four states apart", () => {
    const pr = (over: Partial<RawRef>) => toGithubRef(raw({ pull_request: { merged_at: null }, ...over }), "o/r");
    expect(pr({})).toMatchObject({ kind: "pull", state: "open", draft: false });
    expect(pr({ draft: true })).toMatchObject({ state: "draft", draft: true });
    expect(pr({ state: "closed" }).state).toBe("closed");
    expect(pr({ state: "closed", draft: true }).state).toBe("closed");
    expect(pr({ state: "closed", pull_request: { merged_at: "2026-10-13T16:43:56Z" } }).state).toBe("merged");
  });

  it("does without an author or a date", () => {
    expect(toGithubRef(raw({ user: null, updated_at: null }), "o/r")).toMatchObject({ author: null, updated_at: null });
  });
});

describe("createGithubRefReader", () => {
  function setup(answer: (args: string[]) => GhResult) {
    const calls: string[][] = [];
    let clock = 1_000_000;
    const reader = createGithubRefReader(
      async (args) => {
        calls.push(args);
        return answer(args);
      },
      () => clock,
    );
    return { reader, calls, tick: (ms: number) => (clock += ms) };
  }
  const found = () => ({ out: JSON.stringify(raw()) });

  it("asks gh for the issue by path, as arguments", async () => {
    const { reader, calls } = setup(found);
    expect(await reader("o/r", 72)).toMatchObject({ repo: "o/r", number: 72, title: "A file path opens the file" });
    expect(calls).toEqual([["api", "repos/o/r/issues/72"]]);
  });

  it("never hands gh a repo or number that is not one", async () => {
    const { reader, calls } = setup(found);
    for (const [repo, n] of [["o/r; rm -rf ~", 1], ["../../user", 1], ["o/..", 1], ["o/r", 0], ["o/r", 1.5], ["o/r", NaN]] as const) {
      expect(await reader(repo, n)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("answers from its cache for a minute, then asks again", async () => {
    const { reader, calls, tick } = setup(found);
    await reader("o/r", 72);
    await reader("O/R", 72);
    expect(calls).toHaveLength(1);
    tick(61_000);
    await reader("o/r", 72);
    expect(calls).toHaveLength(2);
  });

  it("asks once for readers that arrive together", async () => {
    const { reader, calls } = setup(found);
    await Promise.all([reader("o/r", 72), reader("o/r", 72)]);
    expect(calls).toHaveLength(1);
  });

  it("remembers a number that is not there, without stopping the others", async () => {
    const { reader, calls } = setup((args) => (args[1].endsWith("/1") ? { failed: "not-found" } : found()));
    expect(await reader("o/r", 1)).toBeNull();
    expect(await reader("o/r", 1)).toBeNull();
    expect(await reader("o/r", 72)).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("stops asking while gh is missing or logged out", async () => {
    const { reader, calls, tick } = setup(() => ({ failed: "no-gh" }));
    expect(await reader("o/r", 1)).toBeNull();
    expect(await reader("o/r", 2)).toBeNull();
    expect(await reader("o/x", 3)).toBeNull();
    expect(calls).toHaveLength(1);
    tick(61_000);
    await reader("o/r", 2);
    expect(calls).toHaveLength(2);
  });

  it("soon asks again after a failure GitHub did not explain", async () => {
    let fail = true;
    const { reader, calls, tick } = setup(() => (fail ? { failed: "other" } : found()));
    expect(await reader("o/r", 72)).toBeNull();
    expect(await reader("o/r", 72)).toBeNull();
    expect(calls).toHaveLength(1);
    fail = false;
    tick(11_000);
    expect(await reader("o/r", 72)).not.toBeNull();
  });

  it("runs only a few gh at once", async () => {
    let out = 0;
    let most = 0;
    const reader = createGithubRefReader(async () => {
      most = Math.max(most, ++out);
      await new Promise((r) => setTimeout(r, 1));
      out--;
      return found();
    });
    const refs = await Promise.all(Array.from({ length: 12 }, (_, i) => reader("o/r", i + 1)));
    expect(refs.every(Boolean)).toBe(true);
    expect(most).toBe(4);
  });

  it("is null for output that is not JSON", async () => {
    const { reader } = setup(() => ({ out: "<html>" }));
    expect(await reader("o/r", 72)).toBeNull();
  });
});
