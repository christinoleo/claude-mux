import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { TranscriptBuilder } from "../../src/transcript/parser.js";
import { ChangesCollector } from "../../src/transcript/changes.js";

/**
 * A real session, trimmed: "Create a file a.txt…", "Append the word two…",
 * then Esc Esc back to before the second prompt, "Restore code and
 * conversation", and "Say hi." — logged with the first turn's last line as
 * its parent, in the same file.
 */
const FIXTURE = readFileSync(join(__dirname, "fixtures", "rewind.jsonl"), "utf8");
const lines = FIXTURE.split("\n").filter(Boolean);

function build(text: string[]): TranscriptBuilder {
  const builder = new TranscriptBuilder();
  for (const line of text) builder.feed(line);
  return builder;
}

const prompts = (b: TranscriptBuilder) =>
  b.entries.flatMap((e) => (e.kind === "user" ? [[e.text.split(" ")[0], e.rewound ?? false]] : []));

describe("a rewind in the transcript", () => {
  it("marks the turn the conversation went back past", () => {
    const b = build(lines);
    expect(prompts(b)).toEqual([
      ["Create", false],
      ["Append", true],
      ["Say", false],
    ]);
    // The old turn's whole reply goes with its prompt; the new one's stays.
    const rewound = b.entries.filter((e) => e.rewound).map((e) => e.kind);
    expect(rewound).toEqual(["user", "thinking", "tool", "text"]);
    expect(b.entries.at(-1)).toMatchObject({ kind: "text", text: "Hi." });
  });

  it("marks nothing until the next prompt shows the fork", () => {
    const sayHi = lines.findIndex((l) => l.includes("Say hi."));
    expect(build(lines.slice(0, sayHi)).entries.some((e) => e.rewound)).toBe(false);
  });

  it("answers the marked entries as changed, for the socket to resend", () => {
    const sayHi = lines.findIndex((l) => l.includes("Say hi."));
    const b = build(lines.slice(0, sayHi));
    const changed = b.feed(lines[sayHi]);
    const append = b.entries.find((e) => e.kind === "user" && e.text.startsWith("Append"))!;
    expect(changed).toContain(append.id);
    expect(changed.at(-1)).not.toBe(append.id);
  });
});

describe("a rewind in the session's changes", () => {
  it("drops the turns the conversation went back past", () => {
    // The second turn appended through Bash, which carries no patch; give it
    // one so there is a change to lose.
    const patched = lines.map((line) =>
      line.includes('"stdout"') || (line.includes('"tool_result"') && line.includes("d4fa9ede"))
        ? line.replace(
            '"isSidechain":false,',
            '"isSidechain":false,"toolUseResult":{"type":"update","filePath":"/tmp/a.txt","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":2,"lines":[" one","+two"]}]},',
          )
        : line,
    );
    const before = new ChangesCollector();
    const sayHi = patched.findIndex((l) => l.includes("Say hi."));
    for (const line of patched.slice(0, sayHi)) before.feed(line);
    expect(before.byTurn().map((t) => t.prompt.split(" ")[0])).toEqual(["Create", "Append"]);

    const after = new ChangesCollector();
    for (const line of patched) after.feed(line);
    expect(after.byTurn().map((t) => t.prompt.split(" ")[0])).toEqual(["Create"]);
    expect(after.promptIds()).toHaveLength(2);
  });
});
