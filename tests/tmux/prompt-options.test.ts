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

describe("readPromptOptions", () => {
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
