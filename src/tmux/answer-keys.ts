/**
 * Translation of an AskUserQuestion answer into Claude Code TUI keystrokes.
 *
 * The dialog puts the cursor on the first option; Down walks the list, Space
 * toggles a checkbox in multi-select, and Enter submits the question. Keeping
 * this next to the other pane-driving code (rather than in the view) means the
 * protocol has one home and can be unit-tested when the TUI changes.
 */

/**
 * Keys for answering one question, given the option indices to pick.
 * Returns null when the selection can't be expressed (no picks, or more than
 * one pick on a single-select question).
 */
export function keysForAnswer(
  picks: number[],
  options: { multiSelect: boolean },
): string | null {
  const sorted = [...new Set(picks)].filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (!options.multiSelect) {
    if (sorted.length > 1) return null;
    return [...Array(sorted[0]).fill("Down"), "Enter"].join(" ");
  }

  const keys: string[] = [];
  let cursor = 0;
  for (const pick of sorted) {
    for (let step = 0; step < pick - cursor; step++) keys.push("Down");
    keys.push("Space");
    cursor = pick;
  }
  keys.push("Enter");
  return keys.join(" ");
}
