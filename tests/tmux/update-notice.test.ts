import { describe, it, expect } from "vitest";
import { readUpdateNotice } from "../../src/tmux/pane.js";

const RULE = "─".repeat(80);

/** The foot of a pane: prompt box, then the footer with a right-aligned notice. */
function foot(footer: string): string {
  return [
    "● Done.",
    "",
    RULE,
    "❯ ",
    RULE,
    "  [█░░░░░░░░░]  8% ctx  Opus 5.5  claude-mux",
    footer,
  ].join("\n");
}

describe("readUpdateNotice", () => {
  it("reads an installed update waiting on a restart", () => {
    expect(
      readUpdateNotice(foot("  ⏵⏵ bypass permissions on (shift+tab to cycle)          ✓ Update installed · Restart to apply"))
    ).toEqual({ kind: "installed", text: "Update installed · Restart to apply" });
  });

  it("reads an update to install by hand, with its command", () => {
    expect(readUpdateNotice(foot("  ? for shortcuts        Update available! Run: npm i -g @anthropic-ai/claude-code"))).toEqual({
      kind: "available",
      text: "Update available! Run: npm i -g @anthropic-ai/claude-code",
    });
  });

  it("reads a failed auto-update", () => {
    expect(readUpdateNotice(foot("  ? for shortcuts        ✗ Auto-update failed · Try claude doctor"))).toEqual({
      kind: "failed",
      text: "Auto-update failed · Try claude doctor",
    });
  });

  it("ignores the notice when the conversation merely quotes it", () => {
    const pane = [
      "● The footer says ✓ Update installed · Restart to apply when it is ready.",
      RULE,
      "❯ ",
      RULE,
      "  ? for shortcuts",
    ].join("\n");
    expect(readUpdateNotice(pane)).toBeNull();
  });

  it("finds nothing in a footer without one", () => {
    expect(readUpdateNotice(foot("  ? for shortcuts"))).toBeNull();
  });

  describe("fullscreen layout", () => {
    const WIDE = "─".repeat(200);
    // Captured from a 200-column fullscreen pane: the notice sits right-aligned
    // above the box's top separator, and the footer below the box is plain.
    const fullscreen = (above: string) =>
      [
        "",
        "✢ Moonwalking… (9m 24s · ↓ 36.2k tokens)",
        above,
        WIDE,
        "❯ ",
        WIDE,
        "  claude-mux Opus 5.5 [█░░░░ 18%] christinoleo@omarchy",
        "  ⏵⏵ bypass permissions on · 1 shell · ← for agents",
      ].join("\n");

    it("reads the notice drawn above the prompt box", () => {
      expect(readUpdateNotice(fullscreen(" ".repeat(157) + "Update available! Run: mise upgrade claude"))).toEqual({
        kind: "available",
        text: "Update available! Run: mise upgrade claude",
      });
    });

    it("ignores a left-aligned line above the box that quotes the notice", () => {
      expect(readUpdateNotice(fullscreen("  Claude said: Update available! Run: mise upgrade claude"))).toBeNull();
    });

    it("ignores a right-aligned notice separated from the box by a blank line", () => {
      const pane = fullscreen(" ".repeat(157) + "Update available! Run: mise upgrade claude").replace(WIDE, "\n" + WIDE);
      expect(readUpdateNotice(pane)).toBeNull();
    });
  });
});
