import { describe, it, expect } from "vitest";
import { TranscriptBuilder, summarizeToolUse } from "../../src/transcript/parser.js";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const TS = "2026-08-27T08:33:54.348Z";

describe("TranscriptBuilder", () => {
  it("parses a typed user prompt (string content)", () => {
    const builder = new TranscriptBuilder();
    const changed = builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: { role: "user", content: "hello world" },
        origin: { kind: "human" },
        promptSource: "typed",
      }),
    );
    expect(changed).toEqual(["u1"]);
    expect(builder.entries).toEqual([
      { kind: "user", id: "u1", ts: Date.parse(TS), text: "hello world" },
    ]);
  });

  it("unwraps a slash command into its name and arguments", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content:
            "<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args>e push</command-args>",
        },
        origin: { kind: "human" },
      }),
    );
    builder.feed(
      line({
        type: "user",
        uuid: "u2",
        timestamp: TS,
        message: {
          role: "user",
          content:
            "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>",
        },
      }),
    );
    expect(builder.entries).toEqual([
      {
        kind: "user",
        id: "u1",
        ts: Date.parse(TS),
        text: "/simplify e push",
        command: { name: "/simplify", args: "e push" },
      },
      {
        kind: "user",
        id: "u2",
        ts: Date.parse(TS),
        text: "/clear",
        command: { name: "/clear" },
      },
    ]);
  });

  it("parses assistant text and thinking blocks, skipping empty thinking", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          id: "msg_1",
          content: [{ type: "thinking", thinking: "pondering", signature: "sig" }],
        },
      }),
    );
    builder.feed(
      line({
        type: "assistant",
        uuid: "a2",
        timestamp: TS,
        message: {
          role: "assistant",
          id: "msg_1",
          content: [{ type: "thinking", thinking: "", signature: "sig-only" }],
        },
      }),
    );
    builder.feed(
      line({
        type: "assistant",
        uuid: "a3",
        timestamp: TS,
        message: { role: "assistant", id: "msg_1", content: [{ type: "text", text: "answer" }] },
      }),
    );
    expect(builder.entries.map((entry) => entry.kind)).toEqual(["thinking", "text"]);
  });

  it("pairs tool_use with its tool_result, preferring the toolUseResult sidecar", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "npm test", description: "Run tests" },
            },
          ],
        },
      }),
    );
    expect(builder.entries).toHaveLength(1);
    const pending = builder.entries[0];
    expect(pending.kind).toBe("tool");
    if (pending.kind === "tool") {
      expect(pending.summary).toBe("Bash: npm test");
      expect(pending.result).toBeUndefined();
    }

    const changed = builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "inline text", is_error: false },
          ],
        },
        toolUseResult: { stdout: "42 passing", stderr: "", interrupted: false },
      }),
    );
    expect(changed).toEqual(["toolu_1"]);
    expect(builder.entries).toHaveLength(1);
    const done = builder.entries[0];
    if (done.kind === "tool") {
      expect(done.result).toEqual({ ok: true, output: "42 passing" });
    }
  });

  it("marks failed tool results and falls back to block content", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }],
        },
      }),
    );
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "no such file", is_error: true },
          ],
        },
      }),
    );
    const entry = builder.entries[0];
    if (entry.kind === "tool") {
      expect(entry.result).toEqual({ ok: false, output: "no such file" });
    }
  });

  it("ignores sidechain, meta, unknown types, and malformed lines", () => {
    const builder = new TranscriptBuilder();
    expect(builder.feed("not json {")).toEqual([]);
    expect(builder.feed("")).toEqual([]);
    expect(
      builder.feed(
        line({
          type: "user",
          isSidechain: true,
          uuid: "s1",
          message: { role: "user", content: "subagent line" },
        }),
      ),
    ).toEqual([]);
    expect(
      builder.feed(
        line({ type: "user", isMeta: true, uuid: "m1", message: { role: "user", content: "meta" } }),
      ),
    ).toEqual([]);
    expect(builder.feed(line({ type: "file-history-snapshot", uuid: "f1" }))).toEqual([]);
    expect(builder.feed(line({ type: "ai-title", title: "x" }))).toEqual([]);
    expect(builder.entries).toEqual([]);
  });

  it("collects user text blocks from array content", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      }),
    );
    const entry = builder.entries[0];
    expect(entry.kind).toBe("user");
    if (entry.kind === "user") {
      expect(entry.text).toBe("part one\n\npart two");
    }
  });

  it("truncates oversized tool results", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat big" } }],
        },
      }),
    );
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "" }],
        },
        toolUseResult: { stdout: "x".repeat(20_000), stderr: "" },
      }),
    );
    const entry = builder.entries[0];
    if (entry.kind === "tool" && entry.result) {
      expect(entry.result.output.length).toBeLessThan(9_000);
      expect(entry.result.output).toContain("[truncated");
    }
  });
});

describe("edit patches", () => {
  it("extracts structuredPatch hunks and drops the redundant text output", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          id: "msg_1",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/a/b.ts" } },
          ],
        },
      }),
    );
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "The file has been updated" },
          ],
        },
        toolUseResult: {
          filePath: "/a/b.ts",
          structuredPatch: [
            { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" ctx", "-old", "+new"] },
          ],
        },
      }),
    );
    const entry = builder.entries[0];
    expect(entry.kind).toBe("tool");
    if (entry.kind === "tool") {
      expect(entry.result).toEqual({ ok: true, output: "" });
      expect(entry.patch).toEqual({
        file: "/a/b.ts",
        hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [" ctx", "-old", "+new"] }],
      });
    }
  });
});

describe("queued prompts", () => {
  it("surfaces a human queued_command and marks it delivered when the turn lands", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "attachment",
        uuid: "q1",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          prompt: "do the thing",
          commandMode: "prompt",
          origin: { kind: "human" },
        },
      }),
    );
    expect(builder.entries).toEqual([
      { kind: "queued", id: "q1", ts: Date.parse(TS), text: "do the thing" },
    ]);

    const changed = builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: { role: "user", content: "do the thing" },
        origin: { kind: "human" },
      }),
    );
    expect(changed).toEqual(["q1", "u1"]);
    expect(builder.entries[0]).toEqual({
      kind: "queued",
      id: "q1",
      ts: Date.parse(TS),
      text: "do the thing",
      delivered: true,
    });
    expect(builder.entries[1].kind).toBe("user");
  });

  it("ignores non-human queued_commands (system notifications)", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "attachment",
        uuid: "q1",
        timestamp: TS,
        attachment: { type: "queued_command", prompt: "<task-notification>…" },
      }),
    );
    expect(builder.entries).toEqual([]);
  });
});

describe("AskUserQuestion", () => {
  const askLine = line({
    type: "assistant",
    uuid: "a1",
    timestamp: TS,
    message: {
      role: "assistant",
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_ask",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which path?",
                header: "Path",
                multiSelect: false,
                options: [
                  { label: "A", description: "first" },
                  { label: "B", description: "second" },
                ],
              },
            ],
          },
        },
      ],
    },
  });

  it("renders a pending ask entry from the tool_use", () => {
    const builder = new TranscriptBuilder();
    builder.feed(askLine);
    expect(builder.entries).toEqual([
      {
        kind: "ask",
        id: "toolu_ask",
        ts: Date.parse(TS),
        questions: [
          {
            question: "Which path?",
            header: "Path",
            multiSelect: false,
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
      },
    ]);
  });

  it("attaches answers from toolUseResult.answers", () => {
    const builder = new TranscriptBuilder();
    builder.feed(askLine);
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: "answered" }],
        },
        toolUseResult: { questions: [], answers: { "Which path?": "B" }, annotations: {} },
      }),
    );
    const entry = builder.entries[0];
    if (entry.kind === "ask") {
      expect(entry.answers).toEqual({ "Which path?": "B" });
      expect(entry.rejected).toBeUndefined();
    }
  });

  it("marks a dismissed dialog as rejected", () => {
    const builder = new TranscriptBuilder();
    builder.feed(askLine);
    builder.feed(
      line({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_ask", content: "rejected", is_error: true },
          ],
        },
        toolUseResult: "User rejected tool use",
      }),
    );
    const entry = builder.entries[0];
    if (entry.kind === "ask") expect(entry.rejected).toBe(true);
  });
});

describe("peer (A2A) messages", () => {
  it("renders origin.kind=peer lines with the clean body and sender name", () => {
    const builder = new TranscriptBuilder();
    builder.feed(
      line({
        type: "user",
        uuid: "p1",
        timestamp: TS,
        isMeta: true,
        origin: {
          kind: "peer",
          name: "pedestrian-f7",
          from: "uds:/run/user/1000/cc-socks/13756.sock",
          body: "You are the implementation worker",
        },
        message: {
          role: "user",
          content: 'Another Claude session sent a message:\n<cross-session-message from="uds:...">…',
        },
      }),
    );
    expect(builder.entries).toEqual([
      {
        kind: "peer",
        id: "p1",
        ts: Date.parse(TS),
        text: "You are the implementation worker",
        from: "pedestrian-f7",
      },
    ]);
  });
});

describe("summarizeToolUse", () => {
  it("prefers command, then file_path, then description", () => {
    expect(summarizeToolUse("Bash", { command: "ls -la" })).toBe("Bash: ls -la");
    expect(summarizeToolUse("Edit", { file_path: "/a/b.ts" })).toBe("Edit: /a/b.ts");
    expect(summarizeToolUse("Task", { description: "Explore repo" })).toBe("Task: Explore repo");
    expect(summarizeToolUse("Weird", {})).toBe("Weird");
  });
});
