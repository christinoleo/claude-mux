import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { scanUsage } from "../../src/usage/scan.js";
import { deserializeCache, serializeCache, type UsageCache } from "../../src/usage/scan-cache.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-mux-usage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One assistant record, as Claude Code writes them. */
function record(messageId: string, requestId: string, output: number, cwd = "/home/me/thing"): string {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-28T12:00:00.000Z",
      sessionId: "sess-1",
      cwd,
      requestId,
      message: {
        id: messageId,
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: output },
      },
    }) + "\n"
  );
}

function write(project: string, file: string, contents: string): string {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, contents);
  return path;
}

describe("scanUsage", () => {
  it("keeps one record per message across the repeated content-block rows", () => {
    // Claude Code repeats the parent message's whole usage object on every
    // content block. Summing them is the 2.2x over-count this guards.
    write("-home-me-thing", "a.jsonl", record("m1", "r1", 10) + record("m1", "r1", 10) + record("m1", "r1", 10));
    const cache: UsageCache = new Map();
    const result = scanUsage(cache, { root });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].totals.output).toBe(10);
  });

  it("keeps usage lines that sit between lines carrying none", () => {
    // The reader gates on the `"usage"` byte sequence before decoding, so a
    // record sandwiched between tool-output lines must still survive.
    const noise = JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n";
    write("-home-me-thing", "a.jsonl", noise + record("m1", "r1", 42) + noise);
    const result = scanUsage(new Map(), { root });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].totals.output).toBe(42);
  });

  it("attributes a record to its project directory and labels it with the real cwd", () => {
    write("-home-me-Projects-thing", "a.jsonl", record("m1", "r1", 10, "/home/me/Projects/thing"));
    const result = scanUsage(new Map(), { root });
    expect(result.records[0].project).toBe("-home-me-Projects-thing");
    expect(result.projectLabels.get("-home-me-Projects-thing")).toBe("/home/me/Projects/thing");
  });

  it("labels a project from the launch cwd, not from wherever the session wandered", () => {
    // A session records its current cwd on every line. One excursion into
    // another repo must not rename the whole project after it.
    write(
      "-home-me",
      "a.jsonl",
      record("m1", "r1", 10, "/home/me") +
        record("m2", "r2", 10, "/home/me") +
        record("m3", "r3", 10, "/home/me/Projects/Quita")
    );
    const result = scanUsage(new Map(), { root });
    expect(result.projectLabels.get("-home-me")).toBe("/home/me");
  });

  it("falls back to the most frequent cwd when none escapes to the directory", () => {
    write(
      "-renamed-on-disk",
      "a.jsonl",
      record("m1", "r1", 10, "/home/me/one") +
        record("m2", "r2", 10, "/home/me/two") +
        record("m3", "r3", 10, "/home/me/two")
    );
    const result = scanUsage(new Map(), { root });
    expect(result.projectLabels.get("-renamed-on-disk")).toBe("/home/me/two");
  });

  it("attributes a subagent transcript to the project above it", () => {
    const dir = join(root, "-home-me-thing", "sess-1", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-x.jsonl"), record("m9", "r9", 5));
    const result = scanUsage(new Map(), { root });
    expect(result.records[0].project).toBe("-home-me-thing");
  });

  it("parses only the appended bytes when a live transcript grows", () => {
    const path = write("-home-me-thing", "a.jsonl", record("m1", "r1", 10));
    const cache: UsageCache = new Map();
    scanUsage(cache, { root });

    appendFileSync(path, record("m2", "r2", 20));
    const grown = scanUsage(cache, { root });

    expect(grown.filesParsed).toBe(1);
    expect(grown.records).toHaveLength(2);
    expect(cache.get(path)?.offset).toBe(cache.get(path)?.size);
  });

  it("reuses the cache untouched when nothing changed", () => {
    write("-home-me-thing", "a.jsonl", record("m1", "r1", 10));
    const cache: UsageCache = new Map();
    scanUsage(cache, { root });
    const again = scanUsage(cache, { root });
    expect(again.filesParsed).toBe(0);
    expect(again.filesReused).toBe(1);
    expect(again.records).toHaveLength(1);
  });

  it("rebuilds from scratch when a transcript is replaced by a shorter one", () => {
    const path = write("-home-me-thing", "a.jsonl", record("m1", "r1", 10) + record("m2", "r2", 20));
    const cache: UsageCache = new Map();
    scanUsage(cache, { root });

    writeFileSync(path, record("m3", "r3", 30));
    const rebuilt = scanUsage(cache, { root });

    expect(rebuilt.records).toHaveLength(1);
    expect(rebuilt.records[0].totals.output).toBe(30);
  });

  it("holds a half-written trailing line until its newline arrives", () => {
    const path = write("-home-me-thing", "a.jsonl", record("m1", "r1", 10));
    const cache: UsageCache = new Map();
    scanUsage(cache, { root });

    const partial = record("m2", "r2", 20);
    const cut = partial.length - 8;
    appendFileSync(path, partial.slice(0, cut));
    expect(scanUsage(cache, { root }).records).toHaveLength(1);

    appendFileSync(path, partial.slice(cut));
    expect(scanUsage(cache, { root }).records).toHaveLength(2);
  });

  it("forgets files that disappeared", () => {
    const path = write("-home-me-thing", "a.jsonl", record("m1", "r1", 10));
    const cache: UsageCache = new Map();
    scanUsage(cache, { root });
    rmSync(path);
    expect(scanUsage(cache, { root }).records).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  it("counts and drops a record repeated in a second file", () => {
    // Zero of these exist in a real local history, which is what lets the
    // per-file cache de-duplicate on its own. If Claude Code ever starts
    // repeating records across files, this count is the warning.
    write("-home-me-thing", "a.jsonl", record("m1", "r1", 10));
    write("-home-me-thing", "b.jsonl", record("m1", "r1", 10));
    const result = scanUsage(new Map(), { root });
    expect(result.crossFileDuplicates).toBe(1);
    expect(result.records).toHaveLength(1);
  });

  it("skips files whose mtime precedes the window", () => {
    write("-home-me-thing", "a.jsonl", record("m1", "r1", 10));
    const result = scanUsage(new Map(), { root, sinceMs: Date.now() + 60_000 });
    expect(result.records).toHaveLength(0);
  });
});

describe("cache serialization", () => {
  it("round-trips records through the interned form", () => {
    write("-home-me-thing", "a.jsonl", record("m1", "r1", 10) + record("m2", "r2", 20));
    const cache: UsageCache = new Map();
    const original = scanUsage(cache, { root });
    const restored = deserializeCache(serializeCache(cache));
    expect(scanUsage(restored, { root }).records).toEqual(original.records);
  });

  it("discards a cache written by an older parser", () => {
    const stale = JSON.stringify({ version: -1, models: [], sessions: [], cwds: [], files: {} });
    expect(deserializeCache(stale).size).toBe(0);
  });

  it("discards anything unparseable rather than throwing", () => {
    expect(deserializeCache("{{{").size).toBe(0);
  });
});
