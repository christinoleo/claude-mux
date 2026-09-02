import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { peekContextPercent, peekContextUsage, resetContextPeekCache } from "../../src/transcript/context-peek.js";

const dir = join(tmpdir(), `claude-mux-peek-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const path = join(dir, "s1.jsonl");

function assistant(input: number, cacheRead: number, model = "claude-haiku-4-5-20251001"): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        model,
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 5 },
      },
    }) + "\n"
  );
}

const user = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";
const session = { id: "s1", cwd: dir, transcript_path: path };

describe("peekContextUsage", () => {
  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    resetContextPeekCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the latest assistant line's usage off the tail of the file", () => {
    writeFileSync(path, user + assistant(1000, 9000) + user + assistant(2000, 38000));
    expect(peekContextUsage(session)?.tokens).toBe(40000);
    // Haiku has a 200k window.
    expect(peekContextPercent(session)).toBe(20);
  });

  it("returns null with no transcript or no reply yet", () => {
    expect(peekContextUsage({ id: "none", cwd: dir, transcript_path: join(dir, "missing.jsonl") })).toBeNull();
    writeFileSync(path, user);
    expect(peekContextUsage(session)).toBeNull();
  });

  it("keeps the last reading through a burst of tool results, and picks up the next reply", () => {
    writeFileSync(path, assistant(1000, 9000));
    expect(peekContextUsage(session)?.tokens).toBe(10000);
    // The file grows by more than the tail window, all of it tool traffic.
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(2000) }] } }) + "\n";
    appendFileSync(path, filler.repeat(50));
    bump();
    expect(peekContextUsage(session)?.tokens).toBe(10000);
    appendFileSync(path, assistant(3000, 60000));
    bump();
    expect(peekContextUsage(session)?.tokens).toBe(63000);
  });

  it("does not reread an unchanged file", () => {
    writeFileSync(path, assistant(1000, 9000));
    const first = peekContextUsage(session);
    // Same object back means the memo answered, not a fresh read.
    expect(peekContextUsage(session)).toBe(first);
  });
});

/** Make sure the mtime moves even on a coarse filesystem clock. */
function bump(): void {
  const t = new Date(Date.now() + 5000);
  utimesSync(path, t, t);
}
