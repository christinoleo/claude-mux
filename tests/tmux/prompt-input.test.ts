import { describe, it, expect } from "vitest";
import { readPromptBox } from "../../src/tmux/pane.js";

const SEP = "─".repeat(80);
const STATUS = ["  [█░░░░░░░░░]  6% ctx  Opus 5  claude-mux", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];

/** Build a pane whose prompt box holds the given lines. */
function pane(boxLines: string[], above: string[] = ["  some earlier output"]): string {
  return [...above, SEP, ...boxLines, SEP, ...STATUS].join("\n");
}

describe("readPromptBox", () => {
  it("returns the text typed on a single line", () => {
    expect(readPromptBox(pane(["❯ fix the login bug"]))).toEqual({ kind: "typed", text: "fix the login bug" });
  });

  it("joins wrapped and multi-line drafts, dropping the two-space indent", () => {
    const content = pane(["❯ this is a long line of typed text that should wrap around", "  the eighty column pane boundary"]);
    expect(readPromptBox(content)).toEqual({
      kind: "typed",
      text: "this is a long line of typed text that should wrap around\nthe eighty column pane boundary",
    });
  });

  it("returns null for the empty box Claude pads with a non-breaking space", () => {
    expect(readPromptBox(pane(["❯  "]))).toBeNull();
  });

  it("returns null while a numbered dialog occupies the box", () => {
    expect(readPromptBox(pane(["  Do you want to run this command?", "❯ 1. Yes", "  2. No"]))).toBeNull();
  });

  it("returns null when the pane has no prompt box", () => {
    expect(readPromptBox("just some scrollback\nwith no separators")).toBeNull();
  });

  it("returns null on empty content", () => {
    expect(readPromptBox("")).toBeNull();
  });

  it("truncates very long pastes", () => {
    const box = readPromptBox(pane([`❯ ${"x".repeat(3000)}`]));
    expect(box?.text).toHaveLength(2001);
    expect(box?.text.endsWith("…")).toBe(true);
  });

  // Captured from a real pane: Claude Code draws its own prompt text faint
  // (SGR 2), and text the user typed with no styling at all.
  describe("with colour captures", () => {
    it("reads faint ghost text as a suggestion", () => {
      const content = pane(["\x1b[39m❯  \x1b[2mdid it finish yet?\x1b[0m"]);
      expect(readPromptBox(content)).toEqual({ kind: "suggestion", text: "did it finish yet?" });
    });

    it("reads unstyled text as typed, even when the caret is coloured", () => {
      const content = pane(["\x1b[38;5;246m❯ \x1b[39mmessage the user is writing"]);
      expect(readPromptBox(content)).toEqual({ kind: "typed", text: "message the user is writing" });
    });

    it("drops Claude Code's own hints, which are drawn faint word by word", () => {
      const content = pane([
        "\x1b[38;5;246m❯  \x1b[2m\x1b[39mPress\x1b[0m \x1b[2mup\x1b[0m \x1b[2mto\x1b[0m \x1b[2medit\x1b[0m \x1b[2mqueued\x1b[0m \x1b[2mmessages\x1b[0m",
      ]);
      expect(readPromptBox(content)).toBeNull();
    });

    it("drops the starter hint on a fresh session", () => {
      expect(readPromptBox(pane(['\x1b[39m❯ \x1b[2mTry "how does auth work?"\x1b[0m']))).toBeNull();
    });

    it("keeps only the typed part when ghost text trails it", () => {
      const content = pane(["\x1b[39m❯ run the \x1b[2mtests again\x1b[0m"]);
      expect(readPromptBox(content)).toEqual({ kind: "typed", text: "run the" });
    });

    it("ignores OSC hyperlinks in the pane", () => {
      const content = pane(["\x1b[39m❯ check \x1b]8;;https://example.com\x1b\\the link\x1b]8;;\x1b\\"]);
      expect(readPromptBox(content)).toEqual({ kind: "typed", text: "check the link" });
    });
  });
});
