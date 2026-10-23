import { describe, it, expect } from "vitest";
import { readRewindScreen, isSamePrompt } from "../../src/tmux/rewind.js";

// Captured from Claude Code 2.1.309 after Esc Esc, then Enter on a row.
const LIST = [
  "● Wrote x to /tmp/claude-1000/rw2/b.txt.                                    │",
  "✻ Cogitated for 3s · done 2:28 PM                                           │",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Rewind",
  "",
  "   Restore the code and/or conversation to the point before…",
  "",
  "     ↑ 11 more",
  "     Reply with only the number 12.",
  "     No code changes",
  "",
  "     Reply with only OK.…",
  "     No code changes",
  "",
  "     Write the word x into b.txt.",
  "     b.txt +1",
  "",
  "   ❯ (current)",
  "",
  "",
  "   Enter to continue · Esc to cancel",
  "",
].join("\n");

const CONFIRM = [
  "✻ Cogitated for 3s · done 2:28 PM                                           │",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Rewind",
  "",
  "   Confirm you want to restore to the point before you sent this message:",
  "",
  "   │ Reply with only OK.",
  "   │ This is a second line.",
  "   │ (40s ago)",
  "",
  "   The conversation will be forked.",
  "   The code will be restored -1 in b.txt.",
  "",
  "   ❯ 1. Restore code and conversation",
  "     2. Restore conversation",
  "     3. Restore code",
  "     4. Summarize from here",
  "   ↓ 5. Summarize up to here",
  "",
  "   ⚠ Rewinding does not affect files edited manually or via bash.",
  "",
].join("\n");

describe("readRewindScreen", () => {
  it("reads the list of points, the selection and what scrolled away", () => {
    expect(readRewindScreen(LIST)).toEqual({
      step: "list",
      above: 11,
      below: 0,
      rows: [
        { text: "Reply with only the number 12.", files: "No code changes", selected: false, current: false },
        { text: "Reply with only OK.…", files: "No code changes", selected: false, current: false },
        { text: "Write the word x into b.txt.", files: "b.txt +1", selected: false, current: false },
        { text: "(current)", files: null, selected: true, current: true },
      ],
    });
  });

  it("reads the confirmation: the quote, its age, the effects and the choices", () => {
    expect(readRewindScreen(CONFIRM)).toEqual({
      step: "confirm",
      prompt: "Reply with only OK.\nThis is a second line.",
      ago: "40s ago",
      effects: ["The conversation will be forked.", "The code will be restored -1 in b.txt."],
      options: [
        { n: 1, label: "Restore code and conversation", selected: true },
        { n: 2, label: "Restore conversation", selected: false },
        { n: 3, label: "Restore code", selected: false },
        { n: 4, label: "Summarize from here", selected: false },
        { n: 5, label: "Summarize up to here", selected: false },
      ],
    });
  });

  it("finds nothing in an ordinary pane, or one that only says the word", () => {
    expect(readRewindScreen("❯ Rewind\n● Rewind is Esc Esc.\n")).toBeNull();
    expect(readRewindScreen("")).toBeNull();
  });
});

describe("isSamePrompt", () => {
  it("matches a row to its prompt's first line, cut or whole", () => {
    expect(isSamePrompt("Reply with only OK.…", "Reply with only OK.\nThis is a second line.")).toBe(true);
    expect(isSamePrompt("Write the word x into b.txt.", "Write the word x into b.txt.")).toBe(true);
    expect(isSamePrompt("Reply with only the number…", "Reply with only the number 12.")).toBe(true);
  });

  it("tells a short row from a longer prompt that starts the same", () => {
    expect(isSamePrompt("go", "go on with the plan")).toBe(false);
    expect(isSamePrompt("Reply with only the number 1.", "Reply with only the number 12.")).toBe(false);
    expect(isSamePrompt("(current)", "anything")).toBe(false);
  });
});

describe("isSamePrompt across renderings", () => {
  it("matches a cut row picked from the list to the confirmation's whole quote", () => {
    expect(isSamePrompt("Reply with only OK.\nThis is a second line.", "Reply with only OK.…")).toBe(true);
  });
});
