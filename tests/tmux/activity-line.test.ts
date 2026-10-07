import { describe, it, expect } from "vitest";
import { readActivity, readActivityLine, isPaneShowingSpinner, isPaneShowingIdlePrompt } from "../../src/tmux/pane.js";

const STATUS_FOOTER = [
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  [█░░░░░░░░░]  8% ctx  Fable 5  claude-mux",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

describe("readActivityLine", () => {
  it("reads a braille compaction spinner", () => {
    const pane = ["⠋ Compacting conversation…", "", STATUS_FOOTER].join("\n");
    expect(readActivityLine(pane)).toBe("Compacting conversation…");
    expect(isPaneShowingSpinner(pane)).toBe(true);
  });

  it("reads the star-family spinner and stops at the ellipsis", () => {
    const pane = ["✻ Julienning… (1m 39s · ↓ 4.8k tokens · esc to interrupt)", "", STATUS_FOOTER].join("\n");
    expect(readActivityLine(pane)).toBe("Julienning…");
  });

  it("does not read the finished form as work", () => {
    const pane = ["✻ Crunched for 4m 58s · done 6:26 PM", STATUS_FOOTER].join("\n");
    expect(readActivityLine(pane)).toBeNull();
    expect(isPaneShowingSpinner(pane)).toBe(false);
  });

  it("ignores braille left in tool output", () => {
    // bun and npm draw braille progress spinners; the last frame stays on screen.
    const pane = ["  ⎿  ⠧ Resolving dependencies", "     ⠸ [12/40] installed", "", STATUS_FOOTER].join("\n");
    expect(isPaneShowingSpinner(pane)).toBe(false);
    expect(isPaneShowingIdlePrompt(pane)).toBe(true);
  });

  it("ignores a star bullet in the answer", () => {
    const pane = ["  ✻ Next: run the tests", "", STATUS_FOOTER].join("\n");
    expect(isPaneShowingSpinner(pane)).toBe(false);
  });

  it("only looks at the foot of the pane", () => {
    const tall = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const pane = ["⠋ Compacting conversation…", ...tall, STATUS_FOOTER].join("\n");
    expect(readActivityLine(pane)).toBeNull();
  });
});

/** The foot of a fullscreen Claude Code pane (`"tui": "fullscreen"`), as captured. */
const FULLSCREEN_FOOT = [
  "",
  "─".repeat(120),
  "❯\u00a0",
  "─".repeat(120),
  "  claude-mux Opus 5.5 [█░░░░ 10%] christinoleo@omarchy",
  "  ⏵⏵ bypass permissions on · 1 shell · ← for agents",
].join("\n");

function fullscreen(spinner: string): string {
  return ["● Running 1 shell command…", "  ⎿  $ bun run test", "", spinner, FULLSCREEN_FOOT].join("\n");
}

describe("readActivity", () => {
  it("reads a spinner while a hook runs", () => {
    const pane = fullscreen("✻ Moonwalking… (running PostToolUse hook · 5m 19s · ↓ 21.3k tokens · thought for 9s)");
    expect(readActivity(pane)).toEqual({
      verb: "Moonwalking…",
      doing: "running PostToolUse hook",
      elapsed_s: 319,
      tokens: { dir: "down", count: "21.3k" },
      thinking: "thought for 9s",
    });
  });

  it("reads a spinner while a tool runs", () => {
    const pane = fullscreen("✢ Meandering… (1m 40s · ↓ 2.6k tokens)");
    expect(readActivity(pane)).toEqual({
      verb: "Meandering…",
      doing: null,
      elapsed_s: 100,
      tokens: { dir: "down", count: "2.6k" },
      thinking: null,
    });
  });

  it("reads a spinner while Claude thinks", () => {
    const pane = fullscreen("✶ Meandering… (1m 43s · ↓ 2.9k tokens · thinking)");
    expect(readActivity(pane)?.thinking).toBe("thinking");
    expect(readActivity(pane)?.elapsed_s).toBe(103);
  });

  it("reads a spinner once Claude has thought", () => {
    const pane = fullscreen("* Meandering… (3m 43s · ↓ 15.1k tokens · thought for 2s)");
    expect(readActivity(pane)).toEqual({
      verb: "Meandering…",
      doing: null,
      elapsed_s: 223,
      tokens: { dir: "down", count: "15.1k" },
      thinking: "thought for 2s",
    });
  });

  it("reads the plain-asterisk frame only at column 0 and with its detail", () => {
    expect(readActivityLine(fullscreen("* Meandering… (14s · ↓ 1.0k tokens)"))).toBe("Meandering…");
    expect(readActivityLine(fullscreen("  * Loading the config…"))).toBeNull();
    // A message line starts at column 0 too.
    expect(readActivityLine(fullscreen("* try again… and again…"))).toBeNull();
  });

  it("keeps a whole count the pane cut the bracket after", () => {
    expect(readActivity("✻ Julienning… (1m 39s")?.elapsed_s).toBe(99);
    expect(readActivity("✻ Julienning… (2m 5s · ↓ 1.2k tokens")?.tokens).toEqual({ dir: "down", count: "1.2k" });
    expect(readActivity("✻ Julienning… (5m")?.elapsed_s).toBeNull();
  });

  it("drops key hints and a part the pane cut short", () => {
    expect(readActivity("✻ Julienning… (1m 39s · ↑ 4.8k tokens · esc to interrupt)")).toMatchObject({
      doing: null,
      tokens: { dir: "up", count: "4.8k" },
    });
    expect(readActivity("✻ Julienning… (running Stop hook · 1h 2m · ↓ 4.8k tok")).toMatchObject({
      doing: "running Stop hook",
      elapsed_s: 3720,
      tokens: null,
    });
  });

  it("has only a verb when the spinner carries no detail", () => {
    expect(readActivity("⠋ Compacting conversation…")).toEqual({
      verb: "Compacting conversation…",
      doing: null,
      elapsed_s: null,
      tokens: null,
      thinking: null,
    });
  });
});
