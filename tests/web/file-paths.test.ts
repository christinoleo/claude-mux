import { describe, it, expect } from "vitest";
import { findFilePaths, parseFilePath } from "../../web/src/lib/file-paths.js";

describe("parseFilePath", () => {
  it("reads relative, absolute and dotted paths", () => {
    expect(parseFilePath("web/src/lib/markdown.ts")).toEqual({ path: "web/src/lib/markdown.ts", line: null });
    expect(parseFilePath("/home/leo/a.ts")).toEqual({ path: "/home/leo/a.ts", line: null });
    expect(parseFilePath("./a.ts")?.path).toBe("./a.ts");
    expect(parseFilePath("../x/a.ts")?.path).toBe("../x/a.ts");
    expect(parseFilePath("~/notes/a.md")?.path).toBe("~/notes/a.md");
  });

  it("splits off a line, a column and a range", () => {
    expect(parseFilePath("src/tmux/pane.ts:120")).toEqual({ path: "src/tmux/pane.ts", line: 120 });
    expect(parseFilePath("src/tmux/pane.ts:120:7")).toEqual({ path: "src/tmux/pane.ts", line: 120 });
    expect(parseFilePath("src/tmux/pane.ts:120-140")).toEqual({ path: "src/tmux/pane.ts", line: 120 });
  });

  it("takes a bare name with a known extension, and names that have none", () => {
    expect(parseFilePath("TranscriptView.svelte")?.path).toBe("TranscriptView.svelte");
    expect(parseFilePath("CLAUDE.md:12")).toEqual({ path: "CLAUDE.md", line: 12 });
    expect(parseFilePath("Makefile")?.path).toBe("Makefile");
    expect(parseFilePath(".gitignore")?.path).toBe(".gitignore");
    expect(parseFilePath("docker/Dockerfile")?.path).toBe("docker/Dockerfile");
  });

  it("takes dotfiles it knows, and SvelteKit's route names", () => {
    expect(parseFilePath(".env.local")?.path).toBe(".env.local");
    expect(parseFilePath("web/.prettierrc")?.path).toBe("web/.prettierrc");
    expect(parseFilePath("web/src/routes/session/[target]/+page.svelte")?.path).toBe(
      "web/src/routes/session/[target]/+page.svelte"
    );
    expect(parseFilePath("web/src/routes/(app)/+layout.ts")?.path).toBe("web/src/routes/(app)/+layout.ts");
  });

  it("refuses what is not a file", () => {
    for (const text of [
      "",
      "and/or",
      "origin/main",
      "src/server",
      "src/server/",
      "/api/sessions",
      "/steer",
      "v0.30.8",
      "0.30.8",
      "1/2",
      "https://example.com/a/b.html",
      "example.com/a/b.html",
      "github.com/owner/repo/blob/main/a.ts",
      "//cdn/a.js",
      "git push origin task/69",
      "foo.bar",
      "e.g.",
      "session.cwd",
      "a/b.ts?x=1",
      ".length",
      ".ts",
      ".tofiles",
      "console.log",
      "owner/repo.git",
      "origin/release-1.x",
    ]) {
      expect(parseFilePath(text), text).toBeNull();
    }
  });

  it("wants a directory when asked", () => {
    expect(parseFilePath("Node.js", true)).toBeNull();
    expect(parseFilePath("src/Node.js", true)?.path).toBe("src/Node.js");
  });
});

describe("findFilePaths", () => {
  const paths = (text: string) => findFilePaths(text).map((f) => text.slice(f.start, f.end));

  it("finds paths in a sentence, without its punctuation", () => {
    expect(paths("See src/a.ts, then (web/b.svelte:12) and ./c/d.md.")).toEqual([
      "src/a.ts",
      "web/b.svelte:12",
      "./c/d.md",
    ]);
    expect(findFilePaths("at src/a.ts:12.")[0]).toMatchObject({ path: "src/a.ts", line: 12 });
  });

  it("finds an absolute path", () => {
    expect(paths("wrote /tmp/out/report.json today")).toEqual(["/tmp/out/report.json"]);
  });

  it("finds nothing in URLs, versions, bare names and prose", () => {
    for (const text of [
      "https://example.com/a/b.html",
      "ssh://host/a/b.ts",
      "git@github.com:owner/repo.git",
      "example.com/a/b.html",
      "v0.30.8 and 1.2.3",
      "this and/or that",
      "Node.js and README.md",
    ]) {
      expect(paths(text), text).toEqual([]);
    }
  });
});
