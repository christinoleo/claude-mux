import { describe, it, expect } from "vitest";
import { isPaneShowingIdlePrompt } from "../../src/tmux/pane.js";

const STATUS_FOOTER = [
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  [█░░░░░░░░░]  8% ctx  Fable 5  claude-mux",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

describe("isPaneShowingIdlePrompt", () => {
  it("detects the ready prompt after an Esc that printed no marker", () => {
    const pane = ["  some finished answer text.", "", "✻ Baked for 33s · done 11:51 AM", "", STATUS_FOOTER].join(
      "\n",
    );
    expect(isPaneShowingIdlePrompt(pane)).toBe(true);
  });

  it("stays busy while an activity spinner line is visible", () => {
    const pane = ["✻ Julienning… (1m 39s · ↓ 4.8k tokens · thought for 18s)", "", STATUS_FOOTER].join("\n");
    expect(isPaneShowingIdlePrompt(pane)).toBe(false);
  });

  it("stays busy while a tool offers esc to interrupt", () => {
    const pane = ["  Running command…", "  esc to interrupt", "", STATUS_FOOTER].join("\n");
    expect(isPaneShowingIdlePrompt(pane)).toBe(false);
  });

  it("does not fire on permission dialogs", () => {
    const pane = ["  Do you want to run this command?", "  ❯ 1. Yes", "    2. No", "", STATUS_FOOTER].join("\n");
    expect(isPaneShowingIdlePrompt(pane)).toBe(false);
  });

  it("does not fire on braille spinners (compaction)", () => {
    const pane = ["⠋ Compacting…", "", STATUS_FOOTER].join("\n");
    expect(isPaneShowingIdlePrompt(pane)).toBe(false);
  });

  it("requires the prompt to be visible", () => {
    expect(isPaneShowingIdlePrompt("plain shell output\n$ ")).toBe(false);
    expect(isPaneShowingIdlePrompt("")).toBe(false);
  });
});
