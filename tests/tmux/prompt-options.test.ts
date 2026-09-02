import { describe, it, expect } from "vitest";
import { readPromptOptions } from "../../src/tmux/pane.js";

/** A permission dialog as Claude Code draws it, frame and all. */
const PERMISSION = [
  "╭──────────────────────────────────────────────╮",
  "│ Bash command                                 │",
  "│                                              │",
  "│   rm -rf dist/ && bun run build              │",
  "│   Rebuild from scratch                       │",
  "│                                              │",
  "│ Do you want to proceed?                      │",
  "│ ❯ 1. Yes                                     │",
  "│   2. Yes, and don't ask again for Bash       │",
  "│   3. No, and tell Claude what to do          │",
  "╰──────────────────────────────────────────────╯",
].join("\n");

/**
 * A question dialog, captured from a pane. Unlike a permission prompt its rows
 * are not adjacent: each label carries an indented description, and a rule
 * separates the last row from the rest.
 */
const QUESTION = [
  "Tabs or spaces?",
  "",
  "❯ 1. Tabs",
  "     Use tab characters for indentation",
  "  2. Spaces",
  "     Use space characters for indentation",
  "  3. Type something.",
  "────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/** A multi-select question: checkboxes, and descriptions at the rows' own indent. */
const MULTI = [
  "←  ☐ Languages  ✔ Submit  →",
  "Which languages do you use?",
  "❯ 1. [ ] Python",
  "  High-level, general-purpose language popular for data science.",
  "  2. [✔] Rust",
  "  Systems programming language known for memory safety and performance.",
  "  3. [ ] Go",
  "  Compiled language designed for simplicity and concurrency.",
  "  4. [ ] Type something",
  "     Submit",
  "────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/** A question with previews: the panel shares the rows' lines, and outlives them. */
const PREVIEW = [
  " ☐ Layout",
  "Which layout do you prefer?",
  "❯ 1. Sidebar on left, content     ┌────────────────────────────┐",
  "    right                         │ ── wrapped label ────────  │",
  "  2. Top navigation               │ ┌──────────┬─────────────┐ │",
  "                                  │ │ Nav      │ Main        │ │",
  "                                  │ └──────────┴─────────────┘ │",
  "                                  └────────────────────────────┘",
  "                                  Notes: press n to add notes",
  "────────────────────────────────────────────────────────────────",
  "  Chat about this",
  "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
].join("\n");

/**
 * The model picker `/model` opens, captured from a pane. A local command's
 * dialog: the hooks never hear of it, its rows carry their descriptions on
 * the same line after a run of spaces, a title paragraph rather than a
 * question sits above them, and a setting the arrows adjust sits below.
 */
const MODEL = [
  "❯ /model",
  "──────────────────────────────────────────────────────────────────────────────",
  "  Select model",
  "  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model",
  "  names, specify with --model.",
  "    1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks",
  "    2. Opus (1M context)      Opus 5 with 1M context · Best for everyday, complex tasks",
  "  ❯ 3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks",
  "    4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "    5. Haiku ✔                Haiku 4.5 · Fastest for quick answers",
  "  ● High effort (default) ←/→ to adjust",
  "  Enter to set as default · s to use this session only · Esc to cancel",
  "",
  "",
].join("\n");

/**
 * A single-select question whose "Type something." row has been picked and
 * typed into, captured from a pane: the row shows the text in place of its
 * label, and the hint grows a key for editing it.
 */
const TYPING = [
  " ☐ Color",
  "Pick a color",
  "  1. Red",
  "     warm",
  "  2. Blue",
  "     cool",
  "❯ 3. purple please",
  "────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel",
].join("\n");

/**
 * A multi-select question's Submit tab, captured from a pane. It names no
 * keys, and its two rows sit at the foot the way a permission prompt's do.
 */
const REVIEW = [
  "←  ☒ Fruits  ✔ Submit  →",
  "Review your answers",
  " ● Which fruits do you like?",
  "   → Banana",
  "Ready to submit your answers?",
  "❯ 1. Submit answers",
  "  2. Cancel",
  "",
  "",
].join("\n");

/**
 * A question with previews after `n`: the notes field is open, its line shows
 * the text (or its placeholder) instead of saying how to open it, and the
 * hint has grown the editing key. Captured from a pane.
 */
const NOTING = [
  " ☐ Layout",
  "Which layout?",
  "❯ 1. Sidebar                      ┌──────────────────────────────────────────┐",
  "  2. Topbar                       │ ┌───┬────┐                               │",
  "                                  │ │nav│main│                               │",
  "                                  │ └───┴────┘                               │",
  "                                  └──────────────────────────────────────────┘",
  "                                  Notes: my note",
  "────────────────────────────────────────────────────────────────────────────",
  "  Chat about this",
  "Enter to select · ↑/↓ to navigate · n to add notes · ctrl+g to edit in Vim · Esc to cancel",
].join("\n");

describe("readPromptOptions", () => {
  it("tells a notes field open for typing from a text row open for typing", () => {
    const noting = readPromptOptions(NOTING);
    expect(noting).not.toBeNull();
    expect(noting!.typing).toBe(true);
    expect(noting!.noting).toBe(true);
    expect(noting!.notes).toEqual(["Notes: my note"]);
    // The same dialog with the field closed is neither.
    const closed = readPromptOptions(
      NOTING.replace("Notes: my note", "Notes: press n to add notes").replace(
        " · ctrl+g to edit in Vim",
        ""
      )
    );
    expect(closed!.typing).toBeUndefined();
    expect(closed!.noting).toBeUndefined();
    expect(closed!.notes).toEqual(["Notes: press n to add notes"]);
  });

  it("reads the model picker, splitting each row's inline description off its label", () => {
    const choice = readPromptOptions(MODEL);
    expect(choice).not.toBeNull();
    expect(choice!.question).toBe("Select model");
    expect(choice!.options.map((o) => o.label)).toEqual([
      "Default (recommended)",
      "Opus (1M context)",
      "Fable",
      "Sonnet",
      "Haiku ✔",
    ]);
    expect(choice!.options[3].hint).toBe("Sonnet 5 · Efficient for routine tasks");
    expect(choice!.options.map((o) => o.selected)).toEqual([false, false, true, false, false]);
    expect(choice!.multi).toBeUndefined();
    expect(choice!.typing).toBeUndefined();
  });

  it("carries the model picker's own key hint and the setting under its rows", () => {
    const choice = readPromptOptions(MODEL);
    expect(choice!.keys).toBe(
      "Enter to set as default · s to use this session only · Esc to cancel"
    );
    expect(choice!.notes).toEqual(["● High effort (default) ←/→ to adjust"]);
    // The note is not the last row's description.
    expect(choice!.options[4].hint).toBe("Haiku 4.5 · Fastest for quick answers");
  });

  it("reads a declared dialog when asked for declared dialogs only, and nothing else", () => {
    expect(readPromptOptions(MODEL, { declaredOnly: true })).not.toBeNull();
    expect(readPromptOptions(QUESTION, { declaredOnly: true })).not.toBeNull();
    // A permission prompt names no keys; without the hooks it is just a list.
    expect(readPromptOptions(PERMISSION, { declaredOnly: true })).toBeNull();
    expect(readPromptOptions(REVIEW, { declaredOnly: true })).toBeNull();
    expect(readPromptOptions(PERMISSION)).not.toBeNull();
  });

  it("says when the highlighted row is open for typing", () => {
    const choice = readPromptOptions(TYPING);
    expect(choice).not.toBeNull();
    expect(choice!.typing).toBe(true);
    expect(choice!.question).toBe("Pick a color");
    expect(choice!.options.map((o) => o.label)).toEqual([
      "Red",
      "Blue",
      "purple please",
      "Chat about this",
    ]);
    expect(choice!.options[2].selected).toBe(true);
    expect(readPromptOptions(QUESTION)!.typing).toBeUndefined();
    expect(readPromptOptions(MULTI)!.typing).toBeUndefined();
  });

  it("reads a multi-select's Submit tab, with the line that asks as its question", () => {
    const choice = readPromptOptions(REVIEW);
    expect(choice).not.toBeNull();
    expect(choice!.question).toBe("Ready to submit your answers?");
    expect(choice!.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
    expect(choice!.keys).toBeUndefined();
  });

  it("reads a multi-select question, checkboxes and all", () => {
    const choice = readPromptOptions(MULTI);
    expect(choice).not.toBeNull();
    expect(choice!.multi).toBe(true);
    expect(choice!.question).toBe("Which languages do you use?");
    expect(choice!.options.map((o) => o.label)).toEqual([
      "Python",
      "Rust",
      "Go",
      "Type something",
      "Chat about this",
    ]);
    expect(choice!.options.map((o) => o.checked)).toEqual([false, true, false, false, undefined]);
  });

  it("keeps a multi-select row's description, which sits at the row's own indent", () => {
    const choice = readPromptOptions(MULTI);
    expect(choice!.options[1].hint).toBe(
      "Systems programming language known for memory safety and performance."
    );
  });

  it("reads a question whose rows share their lines with a preview panel", () => {
    const choice = readPromptOptions(PREVIEW);
    expect(choice).not.toBeNull();
    expect(choice!.question).toBe("Which layout do you prefer?");
    expect(choice!.options.map((o) => o.label)).toEqual([
      "Sidebar on left, content right",
      "Top navigation",
    ]);
    expect(choice!.multi).toBeUndefined();
  });

  it("keeps the preview panel's own lines out of the options", () => {
    const choice = readPromptOptions(PREVIEW);
    expect(choice!.options.every((o) => o.hint === undefined)).toBe(true);
    expect(choice!.options.every((o) => !/[┌│└]/.test(o.label))).toBe(true);
  });

  it("stays strict about distance when the pane never says it is a dialog", () => {
    // The same shape as a preview question, minus the line naming the keys.
    const noHint = PREVIEW.split("\n").slice(0, -1).join("\n");
    expect(readPromptOptions(noHint)).toBeNull();
  });

  it("reads a question whose rows are split by descriptions and a rule", () => {
    const choice = readPromptOptions(QUESTION);
    expect(choice).not.toBeNull();
    expect(choice!.question).toBe("Tabs or spaces?");
    expect(choice!.options.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    expect(choice!.options.map((o) => o.label)).toEqual([
      "Tabs",
      "Spaces",
      "Type something.",
      "Chat about this",
    ]);
    expect(choice!.options[0].selected).toBe(true);
  });

  it("carries each option's own description", () => {
    const choice = readPromptOptions(QUESTION);
    expect(choice!.options.map((o) => o.hint)).toEqual([
      "Use tab characters for indentation",
      "Use space characters for indentation",
      undefined,
      undefined,
    ]);
  });

  it("does not mistake the question for the first option's description", () => {
    const choice = readPromptOptions(
      ["Which one?", "  1. a", "  2. b", "", "Enter to select"].join("\n")
    );
    expect(choice!.question).toBe("Which one?");
    expect(choice!.options.every((o) => o.hint === undefined)).toBe(true);
  });

  it("stops at prose that is not a description, however close it sits", () => {
    // The walk ends at the unindented line, so the run it finds starts at 2 —
    // and a run that does not start at 1 is not a dialog.
    expect(
      readPromptOptions(
        [
          "1. install deps",
          "That is the whole list, and this line is not indented under it.",
          "  2. run build",
          "  3. ship it",
        ].join("\n")
      )
    ).toBeNull();
  });

  it("reads a permission dialog through its frame", () => {
    const choice = readPromptOptions(PERMISSION);
    expect(choice).not.toBeNull();
    expect(choice!.question).toBe("Do you want to proceed?");
    expect(choice!.options).toEqual([
      { n: 1, label: "Yes", selected: true },
      { n: 2, label: "Yes, and don't ask again for Bash", selected: false },
      { n: 3, label: "No, and tell Claude what to do", selected: false },
    ]);
  });

  it("carries Claude Code's own highlight", () => {
    const moved = PERMISSION.replace("│ ❯ 1. Yes", "│   1. Yes").replace(
      "│   3. No,",
      "│ ❯ 3. No,"
    );
    const choice = readPromptOptions(moved);
    expect(choice!.options.map((o) => o.selected)).toEqual([false, false, true]);
  });

  it("reads a dialog drawn without a frame", () => {
    const choice = readPromptOptions(
      ["Which branch should I base this on?", "❯ 1. main", "  2. usage-dashboard"].join("\n")
    );
    expect(choice!.question).toBe("Which branch should I base this on?");
    expect(choice!.options).toHaveLength(2);
  });

  it("accepts `1)` as well as `1.`", () => {
    const choice = readPromptOptions(["Pick one", "❯ 1) keep", "  2) drop"].join("\n"));
    expect(choice!.options.map((o) => o.label)).toEqual(["keep", "drop"]);
  });

  it("ignores a numbered list that isn't at the foot of the pane", () => {
    const prose = [
      "Here are the steps:",
      "1. install deps",
      "2. run build",
      "",
      "All four block direct access, so I went through the index instead.",
      "That took a while but the result is the same either way.",
      "Nothing else to report.",
    ].join("\n");
    expect(readPromptOptions(prose)).toBeNull();
  });

  it("refuses a run whose numbers skip", () => {
    expect(readPromptOptions(["Pick", "  1. a", "  3. b"].join("\n"))).toBeNull();
  });

  it("refuses a lone numbered row", () => {
    expect(readPromptOptions(["Pick", "❯ 1. only"].join("\n"))).toBeNull();
  });

  it("refuses more options than it will carry", () => {
    const many = ["Pick", ...Array.from({ length: 11 }, (_, i) => `  ${i + 1}. option`)];
    expect(readPromptOptions(many.join("\n"))).toBeNull();
  });

  it("truncates a very long option label", () => {
    const long = "x".repeat(200);
    const choice = readPromptOptions(["Pick", `❯ 1. ${long}`, "  2. no"].join("\n"));
    expect(choice!.options[0].label).toHaveLength(121);
    expect(choice!.options[0].label.endsWith("…")).toBe(true);
  });

  it("leaves the question null when nothing readable sits above the run", () => {
    const choice = readPromptOptions(["────────────────", "❯ 1. yes", "  2. no"].join("\n"));
    expect(choice!.question).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(readPromptOptions("")).toBeNull();
  });
});
