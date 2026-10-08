import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ChangesCollector,
  fileChangeFromSidecar,
  resetChangesCache,
  sessionChanges,
} from "../../src/transcript/changes.js";
import { resetContextPeekCache } from "../../src/transcript/context-peek.js";

// Shapes copied from live session logs, trimmed: an Edit, a Write that
// created a file, a Write over an existing one, and a MultiEdit, across two
// turns with harness lines and a subagent's line between them.
const FIXTURE = readFileSync(join(__dirname, "fixtures", "changes.jsonl"), "utf8");

function collect(text: string): ChangesCollector {
  const collector = new ChangesCollector();
  for (const line of text.split("\n")) if (line) collector.feed(line);
  return collector;
}

describe("fileChangeFromSidecar", () => {
  it("counts an Edit's hunks", () => {
    const change = fileChangeFromSidecar({
      filePath: "/a.ts",
      oldString: "x",
      newString: "y",
      originalFile: "x\n",
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }],
    });
    expect(change).toEqual({
      file: "/a.ts",
      kind: "modified",
      additions: 1,
      deletions: 1,
      hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["-x", "+y"] }],
    });
  });

  it("reads a Write that created the file as its whole content added", () => {
    const change = fileChangeFromSidecar({
      type: "create",
      filePath: "/new.md",
      content: "one\ntwo\n",
      structuredPatch: [],
      originalFile: null,
    });
    expect(change).toMatchObject({ kind: "added", additions: 2, deletions: 0 });
    expect(change?.hunks).toEqual([{ header: "@@ -0,0 +1,2 @@", lines: ["+one", "+two"] }]);
  });

  it("counts a Write without originalFile as added", () => {
    const change = fileChangeFromSidecar({ filePath: "/n.txt", content: "a", structuredPatch: [] });
    expect(change).toMatchObject({ kind: "added", additions: 1 });
  });

  it("ignores results that are not file edits", () => {
    expect(fileChangeFromSidecar({ stdout: "ok", stderr: "" })).toBeNull();
    expect(fileChangeFromSidecar(null)).toBeNull();
  });
});

describe("ChangesCollector on a real-shaped log", () => {
  it("groups the changes by the turn that made them", () => {
    const turns = collect(FIXTURE).byTurn();
    expect(turns).toEqual([
      {
        id: "p1",
        n: 1,
        ts: Date.parse("2026-10-08T01:40:00.000Z"),
        prompt: "document the subagents in CLAUDE.md",
        files: [
          { file: "/repo/CLAUDE.md", kind: "modified", additions: 3, deletions: 0 },
          { file: "/repo/canvas.json", kind: "added", additions: 4, deletions: 0 },
        ],
      },
      {
        id: "p2",
        n: 2,
        ts: Date.parse("2026-10-08T01:44:00.000Z"),
        prompt: "/simplify the store",
        files: [
          { file: "/repo/src/game.ts", kind: "modified", additions: 3, deletions: 1 },
          // Applied once, though its result line was written twice.
          { file: "/repo/CLAUDE.md", kind: "modified", additions: 2, deletions: 2 },
        ],
      },
    ]);
  });

  it("folds each file over the whole session, latest hunks last", () => {
    const collector = collect(FIXTURE);
    const files = collector.files();
    expect(files.map((f) => [f.file, f.kind, f.additions, f.deletions])).toEqual([
      ["/repo/CLAUDE.md", "modified", 5, 2],
      ["/repo/canvas.json", "added", 4, 0],
      ["/repo/src/game.ts", "modified", 3, 1],
    ]);
    expect(collector.file("/repo/CLAUDE.md")?.hunks.map((h) => h.header)).toEqual([
      "@@ -70,6 +70,9 @@",
      "@@ -1,2 +1,2 @@",
      "@@ -2,1 +2,1 @@",
    ]);
    expect(collector.summary()).toEqual({ files: 3, additions: 12, deletions: 3 });
  });

  it("returns one turn's hunks for a file when asked", () => {
    const collector = collect(FIXTURE);
    expect(collector.file("/repo/CLAUDE.md", "p2")?.hunks).toHaveLength(2);
    expect(collector.file("/repo/canvas.json", "p2")).toBeNull();
  });

  it("never counts a subagent's line", () => {
    expect(collect(FIXTURE).files().some((f) => f.file === "/repo/side.txt")).toBe(false);
  });
});

describe("sessionChanges", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "changes-"));
    resetChangesCache();
    resetContextPeekCache();
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads the log once, then only what was appended", () => {
    const path = join(home, "s.jsonl");
    const [first, ...rest] = FIXTURE.trimEnd().split("\n");
    writeFileSync(path, first + "\n");
    const session = { id: "s", cwd: home, transcript_path: path };
    expect(sessionChanges(session)?.summary().files).toBe(0);
    appendFileSync(path, rest.join("\n") + "\n");
    expect(sessionChanges(session)?.summary()).toEqual({ files: 3, additions: 12, deletions: 3 });
  });

  it("starts over when the log is rewritten shorter", () => {
    const path = join(home, "s.jsonl");
    writeFileSync(path, FIXTURE);
    const session = { id: "s", cwd: home, transcript_path: path };
    expect(sessionChanges(session)?.summary().files).toBe(3);
    writeFileSync(path, FIXTURE.split("\n").slice(0, 3).join("\n") + "\n");
    expect(sessionChanges(session)?.summary()).toEqual({ files: 1, additions: 3, deletions: 0 });
  });
});

describe("ChangesCollector: where turns start", () => {
  const prompt = (uuid: string, content: string) =>
    JSON.stringify({ type: "user", uuid, message: { role: "user", content } });
  const edit = (id: string) =>
    JSON.stringify({
      type: "user",
      uuid: `r-${id}`,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      toolUseResult: {
        filePath: "/a.ts",
        originalFile: "x\n",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }],
      },
    });

  it("names every turn's prompt, changed something or not", () => {
    const c = collect([prompt("p1", "hello"), prompt("p2", "edit it"), edit("t1")].join("\n"));
    expect(c.promptIds()).toEqual(["p1", "p2"]);
    expect(c.byTurn().map((t) => [t.id, t.n])).toEqual([["p2", 2]]);
  });

  it("folds a pasted command's bundle into the line typed, as the transcript does", () => {
    const bundle = "<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args>now</command-args>";
    const c = collect([prompt("typed", "/simplify now"), prompt("bundle", bundle), edit("t1")].join("\n"));
    expect(c.promptIds()).toEqual(["typed"]);
    expect(c.byTurn().map((t) => [t.id, t.n])).toEqual([["typed", 1]]);
  });
});
