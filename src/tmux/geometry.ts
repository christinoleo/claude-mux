/**
 * The size a pane is held at while nobody is looking at it.
 *
 * Everything claude-mux reads off a pane — the prompt box, the dialog rows,
 * the queue — is read from the screen as Claude Code draws it, and Claude
 * Code draws to the width it has. A session started detached gets tmux's
 * default 80x24, and one left behind by a phone-sized terminal keeps that
 * terminal's width, so a dialog's rows wrap and a description lands on the
 * line the reader takes for the next row. Holding a detached window at one
 * generous size means the readers see the same layout every time.
 *
 * A window with a client attached is left alone: the client's terminal is the
 * right size for the person at it, and tmux resizes the window to it anyway.
 * When that client detaches, the next poll widens the window again.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Wide enough that a model picker row, description and all, fits on one line. */
export const STANDARD_PANE_WIDTH = 200;

/** Tall enough that a question with previews and a long prompt above it fits. */
export const STANDARD_PANE_HEIGHT = 50;

/**
 * Below this a pane is worth widening: dialog rows start wrapping around the
 * width of a phone terminal, and 80 is what tmux hands a detached session.
 */
export const MIN_USEFUL_PANE_WIDTH = 160;

/** The `new-session` arguments that start a detached session at the standard size. */
export function sizeArgsForNewSession(): string[] {
  return ["-x", String(STANDARD_PANE_WIDTH), "-y", String(STANDARD_PANE_HEIGHT)];
}

/**
 * Whether a pane should be widened: nobody is attached to it and it is
 * narrower than the readers want.
 */
export function wantsWidening(pane: { attached: number; width: number }): boolean {
  return pane.attached === 0 && pane.width < MIN_USEFUL_PANE_WIDTH;
}

/**
 * Widen a detached window to the standard size.
 *
 * `resize-window` switches the window to a manual size, which would make the
 * next terminal to attach see a clipped 200-column window rather than its
 * own. Setting `window-size` back to `latest` afterwards keeps the size that
 * was just applied — with no client there is nothing to follow — and lets
 * the next client take the window over as usual.
 *
 * @returns false when tmux refused, e.g. because the window is gone.
 */
export async function widenDetachedWindow(target: string): Promise<boolean> {
  try {
    await execFileAsync(
      "tmux",
      ["resize-window", "-t", target, "-x", String(STANDARD_PANE_WIDTH), "-y", String(STANDARD_PANE_HEIGHT)],
      { timeout: 1000 },
    );
    await execFileAsync("tmux", ["set-option", "-w", "-t", target, "window-size", "latest"], {
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}
