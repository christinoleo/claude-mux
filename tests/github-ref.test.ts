import { describe, it, expect } from "vitest";
import { githubRefVisual, isRefShorthand, isRepoSlug, parseGithubRefUrl, parseRefNumber } from "../src/github-ref.js";

describe("parseGithubRefUrl", () => {
  it("reads a pull request and an issue", () => {
    expect(parseGithubRefUrl("https://github.com/christinoleo/claude-mux/pull/72")).toEqual({
      repo: "christinoleo/claude-mux",
      number: 72,
      kind: "pull",
    });
    expect(parseGithubRefUrl("https://github.com/o/r.js/issues/7?x=1")).toEqual({ repo: "o/r.js", number: 7, kind: "issue" });
  });

  it("is null for anything else", () => {
    for (const href of [
      "https://github.com/o/r",
      "https://github.com/o/r/pull/",
      "https://github.com/o/r/pull/12abc",
      "https://github.com/o/../pull/1",
      "https://github.com/-o/r/pull/1",
      "https://github.com.evil.com/o/r/pull/1",
      "https://evil.com/?https://github.com/o/r/pull/1",
      "mailto:a@github.com",
    ]) {
      expect(parseGithubRefUrl(href), href).toBeNull();
    }
  });
});

describe("isRepoSlug", () => {
  it("takes owner/name and nothing else", () => {
    expect(isRepoSlug("christinoleo/claude-mux")).toBe(true);
    expect(isRepoSlug("o/r.git_x-1")).toBe(true);
    for (const slug of ["", "o", "o/", "/r", "o/r/x", "o/..", "o/.", "-o/r", "o/r?x", "o/r x", "o/r#1", "--flag/r", "o/r\n"]) {
      expect(isRepoSlug(slug), JSON.stringify(slug)).toBe(false);
    }
  });
});

describe("parseRefNumber", () => {
  it("takes a positive whole number written plainly", () => {
    expect(parseRefNumber("72")).toBe(72);
    for (const text of [null, "", "0", "-1", "07", "1.5", "1e3", " 1", "1;ls", "9999999999"]) {
      expect(parseRefNumber(text), String(text)).toBeNull();
    }
  });
});

describe("isRefShorthand", () => {
  const target = { repo: "Owner/Repo", number: 12, kind: "pull" as const };
  it("knows a name for the target from the author's words", () => {
    expect(isRefShorthand("#12", target)).toBe(true);
    expect(isRefShorthand("owner/repo#12", target)).toBe(true);
    expect(isRefShorthand("the fix", target)).toBe(false);
    expect(isRefShorthand("#13", target)).toBe(false);
  });
});

describe("githubRefVisual", () => {
  it("gives each state its own word, and never amber", () => {
    const states = ["open", "draft", "merged", "closed"] as const;
    const pulls = states.map((state) => githubRefVisual({ kind: "pull", state }));
    expect(pulls.map((v) => v.label)).toEqual(["Open", "Draft", "Merged", "Closed"]);
    expect(new Set(pulls.map((v) => v.color)).size).toBe(4);
    const all = [...pulls, githubRefVisual({ kind: "issue", state: "open" }), githubRefVisual({ kind: "issue", state: "closed" })];
    for (const v of all) expect(v.color).not.toBe("#fbbf24");
  });
});
