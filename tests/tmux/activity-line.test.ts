import { describe, it, expect } from "vitest";
import { readActivityLine, isPaneShowingSpinner, isPaneShowingIdlePrompt } from "../../src/tmux/pane.js";

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
