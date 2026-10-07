import { describe, it, expect } from "vitest";
import type { TranscriptEntry } from "../../src/transcript/parser.js";
import { groupToolRuns, summarizeToolRun } from "../../src/transcript/tool-groups.js";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

let seq = 0;
function tool(
  name: string,
  input: Record<string, unknown> = {},
  extra: Partial<ToolEntry> = {}
): ToolEntry {
  const id = `t${++seq}`;
  return {
    kind: "tool",
    id,
    ts: seq,
    name,
    summary: name,
    input: JSON.stringify(input),
    result: { ok: true, output: "" },
    ...extra,
  };
}
const bash = (command: string, extra: Partial<ToolEntry> = {}) => tool("Bash", { command }, extra);
const text = (t: string): TranscriptEntry => ({ kind: "text", id: `x${++seq}`, ts: seq, text: t });
const thinking = (): TranscriptEntry => ({
  kind: "thinking",
  id: `k${++seq}`,
  ts: seq,
  text: "hmm",
});

function shape(entries: TranscriptEntry[]): string[] {
  return groupToolRuns(entries).map((item) =>
    item.kind === "group" ? `group(${item.entries.length}): ${item.summary}` : item.kind
  );
}

describe("summarizeToolRun", () => {
  it("words each category the way the TUI does, in order of first use", () => {
    expect(
      summarizeToolRun([bash("npm test"), bash("git status"), bash("make"), bash("echo hi")])
    ).toBe("Ran 4 shell commands");
    expect(summarizeToolRun([bash("ls src"), bash("git status"), bash("make")])).toBe(
      "Listed 1 directory, ran 2 shell commands"
    );
    expect(
      summarizeToolRun([
        tool("Grep", { pattern: "foo" }),
        tool("mcp__brave-windows__click"),
        tool("mcp__brave-windows__take_snapshot"),
        bash("npm run build"),
      ])
    ).toBe("Searched for 1 pattern, called brave-windows 2 times, ran 1 shell command");
  });

  it("reads a lone search or read through the shell as what it does", () => {
    expect(summarizeToolRun([bash("grep -rn foo src"), bash("cat a.ts"), bash("rg bar")])).toBe(
      "Searched for 2 patterns, read 1 file"
    );
  });

  it("keeps a chained, piped or multi-line command a plain shell command", () => {
    expect(
      summarizeToolRun([bash("ls | wc -l"), bash("cd x && ls"), bash("ls src\nrm -rf build")])
    ).toBe("Ran 3 shell commands");
  });

  it("counts a shell read as one file only when it names one", () => {
    expect(summarizeToolRun([bash("cat a.ts b.ts"), bash("head -50 a.ts")])).toBe(
      "Ran 1 shell command, read 1 file"
    );
  });

  it("covers the built-in file tools and falls back to the tool's name", () => {
    expect(
      summarizeToolRun([
        tool("Read"),
        tool("Read"),
        tool("Glob"),
        tool("Write"),
        tool("Skill"),
        tool("Skill"),
        tool("WebFetch"),
      ])
    ).toBe(
      "Read 2 files, searched for 1 pattern, wrote 1 file, used Skill 2 times, fetched 1 page"
    );
  });

  it("keeps MCP servers whose names hold underscores whole", () => {
    expect(summarizeToolRun([tool("mcp__claude_ai_Claude_Docs__read")])).toBe(
      "Called claude_ai_Claude_Docs 1 time"
    );
  });
});

describe("groupToolRuns", () => {
  it("folds consecutive calls between prose into one group", () => {
    expect(shape([text("a"), bash("x"), bash("y"), bash("z"), text("b")])).toEqual([
      "text",
      "group(3): Ran 3 shell commands",
      "text",
    ]);
  });

  it("leaves a lone call as its own row", () => {
    expect(shape([text("a"), bash("x"), text("b")])).toEqual(["text", "tool", "text"]);
  });

  it("folds thinking inside the run and leaves thinking around it out", () => {
    const items = groupToolRuns([
      thinking(),
      bash("x"),
      thinking(),
      bash("y"),
      thinking(),
      text("b"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "group", "thinking", "text"]);
    const group = items[1];
    expect(group.kind === "group" && group.entries.map((e) => e.kind)).toEqual([
      "tool",
      "thinking",
      "tool",
    ]);
  });

  it("keeps a call in flight live, outside the group", () => {
    const running = bash("sleep 9", { result: undefined });
    expect(shape([bash("a"), bash("b"), running])).toEqual([
      "group(2): Ran 2 shell commands",
      "tool",
    ]);
  });

  it("never folds subagents, todos, plans or diffs, and they end the run", () => {
    const diff = tool(
      "Edit",
      {},
      { patch: { file: "a.ts", hunks: [{ header: "@@", lines: ["+x"] }] } }
    );
    expect(
      shape([bash("a"), tool("Task"), bash("b"), tool("TodoWrite"), bash("c"), diff, bash("d")])
    ).toEqual(["tool", "tool", "tool", "tool", "tool", "tool", "tool"]);
  });

  it("counts failures so the summary can show them", () => {
    const items = groupToolRuns([
      bash("a"),
      bash("b", { result: { ok: false, output: "boom" } }),
      bash("c"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "group", summary: "Ran 3 shell commands", failed: 1 });
  });

  it("keys a group by its first entry, so it keeps its key as calls join it", () => {
    const first = bash("a");
    const before = groupToolRuns([first, bash("b")]);
    const after = groupToolRuns([first, bash("b"), bash("c")]);
    expect(before[0].id).toBe(first.id);
    expect(after[0].id).toBe(first.id);
  });
});
