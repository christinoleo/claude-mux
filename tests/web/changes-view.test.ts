import { describe, it, expect } from "vitest";
import {
  diffRows,
  displayPath,
  isGenerated,
  languageFor,
  statusLetter,
} from "../../web/src/lib/side-panel/changes.js";

describe("Changes pane: the file list", () => {
  it("folds lockfiles and build output away as generated", () => {
    for (const path of [
      "bun.lock",
      "web/package-lock.json",
      "Cargo.lock",
      "go.sum",
      "dist/cli.js",
      "web/.svelte-kit/types/x.d.ts",
      "static/app.min.js",
      "src/__snapshots__/a.test.ts.snap",
      "api/schema_generated.ts",
    ]) {
      expect(isGenerated(path), path).toBe(true);
    }
    for (const path of ["src/server/git.ts", ".beads/issues.jsonl", "notes.md", "distance.ts", "builder/x.ts"]) {
      expect(isGenerated(path), path).toBe(false);
    }
  });

  it("letters each status the way git status does, untracked as ?", () => {
    const base = { file: "a", additions: 0, deletions: 0 };
    expect(statusLetter({ ...base, kind: "modified" })).toBe("M");
    expect(statusLetter({ ...base, kind: "added" })).toBe("A");
    expect(statusLetter({ ...base, kind: "added", untracked: true })).toBe("?");
    expect(statusLetter({ ...base, kind: "deleted" })).toBe("D");
    expect(statusLetter({ ...base, kind: "renamed", oldPath: "b" })).toBe("R");
  });

  it("shows a path under the root relative to it, and any other as it is", () => {
    expect(displayPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(displayPath("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(displayPath("/repository/a.ts", "/repo")).toBe("/repository/a.ts");
    expect(displayPath("src/a.ts", "/repo")).toBe("src/a.ts");
    expect(displayPath("/etc/hosts", null)).toBe("/etc/hosts");
  });
});

describe("Changes pane: a diff's rows", () => {
  it("numbers old and new lines and counts the unchanged lines between hunks", () => {
    const rows = diffRows([
      { header: "@@ -3,3 +3,4 @@", lines: [" a", "-b", "+B", "+C", " d"] },
      { header: "@@ -20,2 +21,2 @@ fn", lines: [" x", "-y", "+Y", "\\ No newline at end of file"] },
    ]);
    expect(rows).toEqual([
      { type: "gap", count: 2 },
      { type: "hunk", header: "@@ -3,3 +3,4 @@" },
      { type: "context", old: 3, new: 3, text: "a" },
      { type: "del", old: 4, new: null, text: "b" },
      { type: "add", old: null, new: 4, text: "B" },
      { type: "add", old: null, new: 5, text: "C" },
      { type: "context", old: 5, new: 6, text: "d" },
      { type: "gap", count: 14 },
      { type: "hunk", header: "@@ -20,2 +21,2 @@ fn" },
      { type: "context", old: 20, new: 21, text: "x" },
      { type: "del", old: 21, new: null, text: "y" },
      { type: "add", old: null, new: 22, text: "Y" },
    ]);
  });

  it("draws a new file's single hunk with no gap above it", () => {
    const rows = diffRows([{ header: "@@ -0,0 +1,2 @@", lines: ["+one", "+two"] }]);
    expect(rows.map((r) => r.type)).toEqual(["hunk", "add", "add"]);
    expect(rows[2]).toMatchObject({ new: 2 });
  });

  it("counts the gaps around a hunk that only inserts after a line", () => {
    const rows = diffRows([
      { header: "@@ -3,0 +4,2 @@", lines: ["+x", "+y"] },
      { header: "@@ -10,2 +12,2 @@", lines: ["-a", "+b", " c"] },
    ]);
    expect(rows.filter((r) => r.type === "gap")).toEqual([
      { type: "gap", count: 3 },
      { type: "gap", count: 6 },
    ]);
  });

  it("still draws a hunk whose header it cannot read, without numbers", () => {
    const rows = diffRows([{ header: "@@ weird @@", lines: [" a", "+b"] }]);
    expect(rows).toEqual([
      { type: "hunk", header: "@@ weird @@" },
      { type: "context", old: null, new: null, text: "a" },
      { type: "add", old: null, new: null, text: "b" },
    ]);
  });

  it("picks a highlighter language from the extension", () => {
    expect(languageFor("src/a.ts")).toBe("typescript");
    expect(languageFor("web/X.svelte")).toBe("xml");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("notes")).toBeNull();
    expect(languageFor(".beads/issues.jsonl")).toBe("json");
  });
});
