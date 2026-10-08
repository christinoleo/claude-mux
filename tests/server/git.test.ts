import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  confinePath,
  gitChanges,
  gitFileDiff,
  parseNumstat,
  parsePorcelainV2,
  parseUnifiedDiff,
  resetGitCache,
} from "../../src/server/git.js";

describe("parsePorcelainV2", () => {
  it("reads ordinary, renamed, unmerged and untracked entries", () => {
    // Captured from `git status --porcelain=v2 -z --untracked-files=all`.
    const out = [
      "1 .M N... 100644 100644 100644 3b18e512dba79e4c8300dd08aeb37f8e728b8dad 3b18e512dba79e4c8300dd08aeb37f8e728b8dad src/a file.ts",
      "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 new.ts",
      "1 D. N... 100644 000000 000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0000000000000000000000000000000000000000 gone.ts",
      "1 .D N... 100644 100644 000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 rm.ts",
      "2 R. N... 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 R100 lib/new name.ts",
      "lib/old name.ts",
      "u UU N... 100644 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 conflict.ts",
      "? notes/todo.md",
      "! ignored.log",
      "",
    ].join("\0");
    expect(parsePorcelainV2(out)).toEqual([
      { file: "src/a file.ts", kind: "modified" },
      { file: "new.ts", kind: "added" },
      { file: "gone.ts", kind: "deleted" },
      { file: "rm.ts", kind: "deleted" },
      { file: "lib/new name.ts", oldPath: "lib/old name.ts", kind: "renamed" },
      { file: "conflict.ts", kind: "modified" },
      { file: "notes/todo.md", kind: "added", untracked: true },
    ]);
  });
});

describe("parseNumstat", () => {
  it("reads counts, renames and binary files", () => {
    const out = ["3\t1\tsrc/a.ts", "0\t0\t", "lib/old.ts", "lib/new.ts", "-\t-\timg.png", ""].join("\0");
    const counts = parseNumstat(out);
    expect(counts.get("src/a.ts")).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(counts.get("lib/new.ts")).toEqual({ additions: 0, deletions: 0, binary: false });
    expect(counts.has("lib/old.ts")).toBe(false);
    expect(counts.get("img.png")).toEqual({ additions: 0, deletions: 0, binary: true });
  });
});

describe("parseUnifiedDiff", () => {
  it("splits hunks and drops the file header", () => {
    const out = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@ function f() {",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(out)).toEqual({
      binary: false,
      hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [" keep", "-old", "+new", "\\ No newline at end of file"] }],
    });
  });

  it("flags a binary diff", () => {
    expect(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary).toBe(true);
  });
});

describe("confinePath", () => {
  it("keeps paths inside the root and rejects the rest", () => {
    expect(confinePath("/repo", "src/a.ts")).toBe("src/a.ts");
    expect(confinePath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(confinePath("/repo", "src/../b.ts")).toBe("b.ts");
    expect(confinePath("/repo", "../etc/passwd")).toBeNull();
    expect(confinePath("/repo", "/etc/passwd")).toBeNull();
    expect(confinePath("/repo", "/repo")).toBeNull();
    expect(confinePath("/repo", "/repository/x")).toBeNull();
    expect(confinePath("/repo", "")).toBeNull();
  });
});

describe("gitChanges on a real repo", () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

  beforeEach(() => {
    resetGitCache();
    repo = mkdtempSync(join(tmpdir(), "git-changes-"));
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "old.txt"), "keep\nme\nhere\n");
    writeFileSync(join(repo, "rm.txt"), "bye\n");
    run("add", ".");
    run("commit", "-qm", "init");
  });

  afterEach(() => {
    resetGitCache();
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns null outside a work tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      expect(await gitChanges(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("lists modified, renamed, deleted, untracked and binary files with counts", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n2\nthree\n");
    renameSync(join(repo, "old.txt"), join(repo, "new.txt"));
    run("add", "-A", "old.txt", "new.txt");
    unlinkSync(join(repo, "rm.txt"));
    writeFileSync(join(repo, "fresh.md"), "a\nb\nc\n");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));

    const changes = await gitChanges(repo);
    const byFile = Object.fromEntries((changes?.files ?? []).map((f) => [f.file, f]));
    expect(byFile["a.txt"]).toEqual({ file: "a.txt", kind: "modified", additions: 2, deletions: 1 });
    expect(byFile["new.txt"]).toMatchObject({ oldPath: "old.txt", kind: "renamed", additions: 0, deletions: 0 });
    expect(byFile["rm.txt"]).toMatchObject({ kind: "deleted", deletions: 1 });
    expect(byFile["fresh.md"]).toEqual({ file: "fresh.md", kind: "added", untracked: true, additions: 3, deletions: 0 });
    expect(byFile["blob.bin"]).toMatchObject({ untracked: true, binary: true });
  });

  it("diffs a tracked file, an untracked one, and a binary one", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n2\n");
    writeFileSync(join(repo, "fresh.md"), "hello\n");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2]));

    const tracked = await gitFileDiff(repo, "a.txt");
    expect(tracked).toEqual({
      file: "a.txt",
      binary: false,
      hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [" one", "-two", "+2"] }],
    });
    expect((await gitFileDiff(repo, "fresh.md"))?.hunks).toEqual([
      { header: "@@ -0,0 +1 @@", lines: ["+hello"] },
    ]);
    expect((await gitFileDiff(repo, "blob.bin"))?.binary).toBe(true);
  });

  it("refuses paths outside the repo or not changed", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    expect(await gitFileDiff(repo, "../../etc/passwd")).toBeNull();
    expect(await gitFileDiff(repo, "/etc/passwd")).toBeNull();
    expect(await gitFileDiff(repo, "old.txt")).toBeNull();
  });
});
