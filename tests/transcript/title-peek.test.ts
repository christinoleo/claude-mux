import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { lastCustomTitle, peekTranscriptTitle, resetContextPeekCache } from "../../src/transcript/context-peek.js";

const dir = join(tmpdir(), `claude-mux-title-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const path = join(dir, "s1.jsonl");
const session = { id: "s1", cwd: dir, transcript_path: path };

const title = (t: string) => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "s1" }) + "\n";
const user = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";
const renameCmd =
  JSON.stringify({
    type: "system",
    subtype: "local_command",
    content: "<command-name>/rename</command-name>\n<command-args>parser entre linhas</command-args>",
  }) + "\n";

describe("lastCustomTitle", () => {
  it("takes the newest record and ignores the /rename command echo", () => {
    const lines = (title("first") + renameCmd + title("parser entre linhas") + user).split("\n");
    expect(lastCustomTitle(lines)).toBe("parser entre linhas");
  });

  it("is undefined when the window holds no record", () => {
    expect(lastCustomTitle((user + user).split("\n"))).toBeUndefined();
  });

  it("skips a record cut at the head of the window", () => {
    const cut = title("whole").slice(20);
    expect(lastCustomTitle((cut + user).split("\n"))).toBeUndefined();
  });
});

describe("peekTranscriptTitle", () => {
  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    resetContextPeekCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("follows a rename made inside Claude Code", () => {
    writeFileSync(path, user);
    expect(peekTranscriptTitle(session)).toBeUndefined();
    appendFileSync(path, renameCmd + title("bugs"));
    expect(peekTranscriptTitle(session)).toBe("bugs");
    // Claude Code keeps appending the record; a tail of other traffic keeps the name.
    appendFileSync(path, user.repeat(3));
    expect(peekTranscriptTitle(session)).toBe("bugs");
    appendFileSync(path, title("sidebar"));
    expect(peekTranscriptTitle(session)).toBe("sidebar");
  });
});
