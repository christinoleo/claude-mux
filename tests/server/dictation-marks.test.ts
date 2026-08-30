import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isDictated,
  recordDictation,
  resetDictationMarksForTest,
} from "../../src/server/dictation-marks";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-mux-dictation-"));
  process.env.CLAUDE_MUX_DICTATION_PATH = join(dir, "dictation.json");
  resetDictationMarksForTest();
});

afterEach(() => {
  delete process.env.CLAUDE_MUX_DICTATION_PATH;
  resetDictationMarksForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("dictation marks", () => {
  it("matches a recorded dictation by text within the window", () => {
    recordDictation("s1", "fix the login bug");
    expect(isDictated("s1", "fix the login bug", Date.now())).toBe(true);
  });

  it("matches despite whitespace differences", () => {
    recordDictation("s1", "  fix   the login bug ");
    expect(isDictated("s1", "fix the login bug\n", Date.now())).toBe(true);
  });

  it("does not match a different session", () => {
    recordDictation("s1", "fix the login bug");
    expect(isDictated("s2", "fix the login bug", Date.now())).toBe(false);
  });

  it("does not match edited text", () => {
    recordDictation("s1", "fix the login bug");
    expect(isDictated("s1", "fix the login bug now", Date.now())).toBe(false);
  });

  it("does not match outside the time window", () => {
    recordDictation("s1", "fix the login bug");
    expect(isDictated("s1", "fix the login bug", Date.now() + 16 * 60_000)).toBe(false);
  });

  it("persists marks to disk and reloads them", () => {
    recordDictation("s1", "fix the login bug");
    expect(existsSync(process.env.CLAUDE_MUX_DICTATION_PATH!)).toBe(true);
    // Simulate a server restart: drop in-memory state, keep the file.
    resetDictationMarksForTest();
    expect(isDictated("s1", "fix the login bug", Date.now())).toBe(true);
  });

  it("caps the number of marks kept per session", () => {
    for (let i = 0; i < 150; i++) recordDictation("s1", `prompt number ${i}`);
    expect(isDictated("s1", "prompt number 0", Date.now())).toBe(false);
    expect(isDictated("s1", "prompt number 149", Date.now())).toBe(true);
  });
});
