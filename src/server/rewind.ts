/**
 * Driving Claude Code's rewind from the transcript.
 *
 * Claude Code keeps the checkpoints and decides what a rewind does, so this
 * only works its dialog the way a person at the pane would (see
 * `src/tmux/rewind.ts` for what the dialog draws): Esc Esc, Up to the prompt,
 * Enter, then a digit for the choice. Each step reads the pane back before the
 * next, and the row is checked to be the prompt asked for before Enter goes
 * in, so a list that is longer or shorter than the transcript expected moves
 * the selection a few rows further, never onto someone else's turn.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { capturePaneContentAsync, readPromptBox } from "../tmux/pane.js";
import { isSamePrompt, readRewindScreen, type RewindChoice, type RewindScreen } from "../tmux/rewind.js";

const execFileAsync = promisify(execFile);

export type RewindResult = { ok: true } | { ok: false; error: string };

/** How far from where it was expected the prompt's row is looked for. */
const SEARCH_ROWS = 8;

async function keys(target: string, ...names: string[]): Promise<void> {
  await execFileAsync("tmux", ["send-keys", "-t", target, ...names], { timeout: 1000 });
}

async function screen(target: string): Promise<RewindScreen> {
  const content = await capturePaneContentAsync(target);
  return content ? readRewindScreen(content) : null;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the pane until `test` holds, for up to `ms`. */
async function waitFor(
  target: string,
  test: (s: RewindScreen) => boolean,
  ms = 2000,
): Promise<RewindScreen | undefined> {
  for (const until = Date.now() + ms; ; ) {
    const s = await screen(target);
    if (test(s)) return s;
    if (Date.now() > until) return undefined;
    await pause(120);
  }
}

/** Escape out of the dialog, a step at a time; true once it is gone. */
export async function closeRewind(target: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if ((await screen(target)) === null) return true;
    await keys(target, "Escape");
    if ((await waitFor(target, (s) => s === null, 600)) !== undefined) return true;
  }
  return (await screen(target)) === null;
}

/** The selected row's text, or null when the list is not on screen. */
function selectedRow(s: RewindScreen): string | null {
  return s?.step === "list" ? (s.rows.find((row) => row.selected)?.text ?? null) : null;
}

/**
 * Open the confirmation for going back to before `prompt`. `back` is how many
 * rows above "(current)" the transcript expects it, counting it; null works
 * the list already open from wherever its selection stands.
 */
export async function openRewindAt(target: string, prompt: string, back: number | null): Promise<RewindResult> {
  let s = await screen(target);
  if (back !== null || s?.step !== "list") {
    if (s !== null && !(await closeRewind(target))) return { ok: false, error: "The rewind dialog would not close." };
    // Esc Esc on a box with text in it clears the text instead.
    const box = readPromptBox((await capturePaneContentAsync(target, true)) ?? "");
    if (box?.kind === "typed") return { ok: false, error: "Clear what is typed in the pane's prompt box first." };
    await keys(target, "Escape");
    await pause(150);
    await keys(target, "Escape");
    s = (await waitFor(target, (x) => x?.step === "list")) ?? null;
    if (s?.step !== "list") {
      await closeRewind(target);
      return { ok: false, error: "Claude Code did not open its rewind list." };
    }
    if (back && back > 0) {
      await keys(target, ...Array<string>(back).fill("Up"));
      await waitFor(target, (x) => x?.step === "list" && !x.rows.find((r) => r.selected)?.current, 800);
      await pause(100);
    }
  }

  // Nearest first: where it was expected, then a row either way, and so on.
  // After each move the selection is read once it has moved (or a moment has
  // passed, at either end of the list): a read before the redraw would name
  // the row just left.
  let at = 0;
  let row = selectedRow(await screen(target));
  for (const offset of [0, ...Array.from({ length: SEARCH_ROWS }, (_, i) => [i + 1, -(i + 1)]).flat()]) {
    const step = offset - at;
    if (step !== 0) {
      const before = row;
      await keys(target, ...Array<string>(Math.abs(step)).fill(step > 0 ? "Up" : "Down"));
      at = offset;
      const moved = await waitFor(target, (x) => x?.step === "list" && selectedRow(x) !== before, 600);
      row = selectedRow(moved ?? (await screen(target)));
    }
    if (row !== null && isSamePrompt(row, prompt)) {
      await keys(target, "Enter");
      const confirm = await waitFor(target, (x) => x?.step === "confirm");
      if (confirm?.step === "confirm" && isSamePrompt(confirm.prompt, prompt)) {
        return { ok: true };
      }
      await closeRewind(target);
      return { ok: false, error: "Claude Code confirmed a different prompt; nothing was rewound." };
    }
  }
  await closeRewind(target);
  return { ok: false, error: "That prompt is not in Claude Code's rewind list." };
}

/** Pick a choice in the confirmation on screen, by its label. */
export async function chooseRewind(target: string, choice: RewindChoice): Promise<RewindResult> {
  const s = await screen(target);
  if (s?.step !== "confirm") return { ok: false, error: "The rewind confirmation is not open." };
  const option = s.options.find((o) => o.label === choice);
  if (!option) return { ok: false, error: `Claude Code does not offer "${choice}" here.` };
  await keys(target, String(option.n));
  // The summaries run a turn of their own; the restores close at once.
  if ((await waitFor(target, (x) => x === null, 3000)) === undefined) {
    return { ok: false, error: "The rewind dialog is still open." };
  }
  return { ok: true };
}

