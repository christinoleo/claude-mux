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
    // Same arrow walk as a pane dialog, from a cursor that always starts at 0.
    return keysForOptionPick(0, sorted[0], sorted[0] + 1);
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

/**
 * Keys that move Claude Code's own highlight from the row it is on to the row
 * the user tapped, then submit.
 *
 * Walks with arrows from where the pane says the highlight already is, rather
 * than typing the option's number — a dialog that does not take digits still
 * answers correctly, and a dialog whose highlight has moved since the last
 * capture lands on the row the user could see.
 *
 * @param from Index of the highlighted row, or -1 when none is marked.
 * @param to Index of the row to pick.
 * @returns The key sequence, or null when `to` is not a real row.
 */
export function keysForOptionPick(from: number, to: number, count: number): string | null {
  const move = keysForOptionMove(from, to, count);
  if (move === null) return null;
  return move ? `${move} Enter` : "Enter";
}

/**
 * Keys that move the highlight to a row without picking it.
 *
 * Some dialogs hang a setting off the highlighted row — the model picker's
 * effort level applies to whichever model the highlight is on — and a
 * question's notes field opens for the highlighted option, so moving the
 * highlight is an action of its own, not just the first half of a pick.
 *
 * @returns The arrow keys, "" when the highlight is already there, or null
 *          when `to` is not a real row.
 */
export function keysForOptionMove(from: number, to: number, count: number): string | null {
  if (!Number.isInteger(to) || to < 0 || to >= count) return null;
  const start = from < 0 || from >= count ? 0 : from;
  const steps = to - start;
  return Array(Math.abs(steps)).fill(steps > 0 ? "Down" : "Up").join(" ");
}
