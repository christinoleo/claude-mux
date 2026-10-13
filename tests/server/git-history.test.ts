import { describe, it, expect } from "vitest";
import { parseLog, parseNameStatus, parseWorktrees } from "../../src/server/git-history.js";

const R = "\x1e";
const F = "\x1f";

describe("parseLog", () => {
  it("reads each commit with its parents, refs and line counts", () => {
    const out =
      `${R}aaa1111${F}bbb2222 ccc3333${F}Leo${F}1791900000${F}HEAD -> main, tag: v1.2, origin/main, origin/HEAD${F}Merge the worker's branch\n` +
      `\n 3 files changed, 40 insertions(+), 2 deletions(-)\n` +
      `${R}bbb2222${F}${F}Leo${F}1791800000${F}${F}First commit, with a | pipe and "quotes"\n\n 1 file changed, 5 insertions(+)\n`;
    expect(parseLog(out)).toEqual([
      {
        hash: "aaa1111",
        parents: ["bbb2222", "ccc3333"],
        author: "Leo",
        at: 1791900000000,
        subject: "Merge the worker's branch",
        refs: ["main", "tag: v1.2", "origin/main"],
        files: 3,
        additions: 40,
        deletions: 2,
      },
      {
        hash: "bbb2222",
        parents: [],
        author: "Leo",
        at: 1791800000000,
        subject: 'First commit, with a | pipe and "quotes"',
        refs: [],
        files: 1,
        additions: 5,
        deletions: 0,
      },
    ]);
  });

  it("counts nothing for a commit git prints no stat line for", () => {
    expect(parseLog(`${R}aaa1111${F}bbb2222${F}Leo${F}1${F}${F}Empty merge\n`)[0]).toMatchObject({ files: 0, additions: 0 });
  });
});

describe("parseWorktrees", () => {
  it("lists every checkout with its branch, and a detached one with none", () => {
    const out = [
      "worktree /repo\nHEAD 1111111\nbranch refs/heads/main",
      "worktree /repo/.worktree/105\nHEAD 2222222\nbranch refs/heads/task/105",
      "worktree /repo/.worktree/bisect\nHEAD 3333333\ndetached",
    ].join("\n\n");
    expect(parseWorktrees(out)).toEqual([
      { path: "/repo", branch: "main", hash: "1111111" },
      { path: "/repo/.worktree/105", branch: "task/105", hash: "2222222" },
      { path: "/repo/.worktree/bisect", branch: null, hash: "3333333" },
    ]);
  });
});

describe("parseNameStatus", () => {
  it("reads plain entries and a rename's two paths", () => {
    expect(parseNameStatus("M\0src/a.ts\0A\0src/new file.ts\0R096\0old/name.ts\0new/name.ts\0D\0gone.ts\0")).toEqual([
      { file: "src/a.ts", kind: "modified" },
      { file: "src/new file.ts", kind: "added" },
      { file: "new/name.ts", oldPath: "old/name.ts", kind: "renamed" },
      { file: "gone.ts", kind: "deleted" },
    ]);
  });
});
