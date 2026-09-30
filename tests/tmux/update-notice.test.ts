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
});
