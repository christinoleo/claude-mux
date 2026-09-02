import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { isInTmux } from "./detect.js";

const execFileAsync = promisify(execFile);

/**
 * Capture the contents of a tmux pane.
 * @param target - The tmux target in format "session:window.pane"
 * @returns The pane contents as a string, or null if capture failed
 */
export function capturePaneContent(target: string): string | null {
  if (!isInTmux()) {
    return null;
  }

  try {
    const result = execFileSync("tmux", ["capture-pane", "-p", "-t", target], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1000,
    });
    return result;
  } catch {
    return null;
  }
}

// child_process timeout sends SIGTERM but does not settle the promise if the
// subprocess is wedged (D state, blocked stdio pipe). Wrap with a hard race so
// callers can never hang the broadcast pipeline.
function hardTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/**
 * Batch-fetch all pane titles in a single tmux command.
 * Returns a Map of "session:window.pane" -> title (or null if pane has no title).
 */
export async function getAllPaneTitles(): Promise<Map<string, PaneInfo>> {
  const result = new Map<string, PaneInfo>();
  const stdout = await hardTimeout(
    execFileAsync("tmux", [
      "list-panes", "-a", "-F",
      "#{session_name}:#{window_index}.#{pane_index}\t#{session_attached}\t#{pane_width}\t#{pane_title}"
    ], { encoding: "utf-8", timeout: 2000 }).then((r) => r.stdout),
    2500,
    "",
  );
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    // The title comes last because it is the one field that may hold a tab.
    const [target, attached, width, ...rest] = line.split("\t");
    if (!target || rest.length === 0) continue;
    const title = rest.join("\t").trim();
    result.set(target, {
      title: title || null,
      attached: Number(attached) || 0,
      width: Number(width) || 0,
    });
  }
  return result;
}

/** Press one key in a pane without blocking the poll; false when tmux refused. */
export async function sendKeyAsync(target: string, key: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["send-keys", "-t", target, key], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/** What one `list-panes` line says about a pane, beyond that it exists. */
export type PaneInfo = {
  title: string | null;
  /** Clients attached to the pane's session — 0 means nobody is looking. */
  attached: number;
  /** Columns the pane is drawn at, which is what its text wraps to. */
  width: number;
};

/**
 * Async version of capturePaneContent. Does not block the event loop.
 */
export async function capturePaneContentAsync(target: string, withColor = false): Promise<string | null> {
  const args = withColor ? ["capture-pane", "-p", "-e", "-t", target] : ["capture-pane", "-p", "-t", target];
  return hardTimeout(
    execFileAsync("tmux", args, {
      encoding: "utf-8",
      timeout: 1000,
    }).then((r) => r.stdout),
    1500,
    null,
  );
}

/**
 * Check if the pane shows a spinner (e.g. during compaction).
 * Claude Code uses braille spinner characters (U+2800–U+28FF) in the status area.
 * Checks the bottom few lines of the pane where the spinner would appear.
 */
export function isPaneShowingSpinner(content: string): boolean {
  if (!content) return false;
  const bottomLines = content.split('\n').slice(-5).join('');
  // Braille spinner characters: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ etc. (U+2800-U+28FF)
  return /[\u2800-\u28FF]/.test(bottomLines);
}

/**
 * Heuristic for the Esc edge case hooks can't see: a `busy` session whose
 * pane shows no work indicator anymore was interrupted (Esc during thinking
 * prints no "Interrupted" marker in recent Claude Code versions). Inspects
 * only the bottom lines with cheap string checks; callers should debounce.
 */
export function isPaneShowingIdlePrompt(content: string): boolean {
  if (!content) return false;
  const bottom = content.split("\n").slice(-12);
  const joined = bottom.join("\n");
  // Any active-work or dialog indicator vetoes idle.
  if (/[⠀-⣿]/.test(joined)) return false; // braille spinner
  if (/esc to interrupt|esc to cancel|ctrl\+c to interrupt/i.test(joined)) return false;
  // Activity status line: spinner glyph + word ending in "…", e.g. "✻ Julienning… (1m 39s"
  // (the finished form "✻ Baked for 33s · done" has no "…" and passes).
  if (bottom.some((line) => /^\s*[^\w\s❯│>]\s+\S+…/.test(line))) return false;
  if (/Do you want|❯\s+\d+\./.test(joined)) return false;
  // The ready input prompt must actually be visible.
  return bottom.some((line) => /^❯/.test(line.trim()));
}

/** Max characters of prompt text we carry to the UI, so a huge paste can't bloat broadcasts. */
const MAX_PROMPT_INPUT_CHARS = 2000;

/**
 * Claude Code's own hints, which it renders in the prompt box in the same faint
 * style as a prompt suggestion. They are UI instructions, not a prompt anyone
 * would want to accept, so they are dropped rather than shown.
 */
const PROMPT_HINTS = [/^Press \w+ to /i, /^Try "/i, /^\?\s/];

/** Strip ANSI escape sequences (CSI colours and OSC hyperlinks) from pane text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** One visible character of pane text, with the faint (SGR 2) flag it was drawn under. */
interface Cell {
  ch: string;
  faint: boolean;
}

/**
 * Walk one captured line, tracking SGR 2 (faint) — the style Claude Code uses
 * for text it wrote into the prompt box itself, as opposed to text the user
 * typed, which carries no styling.
 */
function scanCells(line: string): Cell[] {
  const cells: Cell[] = [];
  let faint = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\x1b" && line[i + 1] === "]") {
      // OSC (hyperlink): runs to BEL or ST.
      const bel = line.indexOf("\x07", i);
      const st = line.indexOf("\x1b\\", i + 2);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) break;
      i = end + (end === st ? 1 : 0);
      continue;
    }
    if (ch === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      for (const param of line.slice(i + 2, end).split(";")) {
        const code = Number(param || "0");
        if (code === 2) faint = true;
        else if (code === 0 || code === 22) faint = false;
      }
      i = end;
      continue;
    }
    cells.push({ ch, faint });
  }

  return cells;
}

/**
 * Locate Claude Code's prompt box: the region between the last two `─────`
 * separators in the pane (see the diagram on detectRecentInterruption).
 */
function findPromptBox(lines: string[]): { topSepIdx: number; bottomSepIdx: number } | null {
  let bottomSepIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('─────')) {
      bottomSepIdx = i;
      break;
    }
  }
  if (bottomSepIdx === -1) return null;

  let topSepIdx = -1;
  for (let i = bottomSepIdx - 1; i >= 0; i--) {
    if (lines[i].startsWith('─────')) {
      topSepIdx = i;
      break;
    }
  }
  if (topSepIdx === -1) return null;

  return { topSepIdx, bottomSepIdx };
}

/**
 * What the prompt box currently holds.
 * - `typed`: text a human put there, which rides along with anything sent to
 *   the pane and therefore needs showing.
 * - `suggestion`: Claude Code's own next-prompt proposal (faint ghost text).
 *   Tab or Right arrow inserts it; Enter then submits.
 */
export type PromptBox = { kind: 'typed' | 'suggestion'; text: string } | null;

/**
 * Read the prompt box out of a pane capture.
 *
 * Pass a capture taken with `tmux capture-pane -e` to tell typed text from
 * Claude Code's faint ghost text; without escape codes everything reads as
 * typed. The first line of the box carries the `❯` marker, and wrapped or
 * multi-line drafts are indented by two spaces.
 *
 * @returns null when the box is empty, absent, showing a dialog, or holding
 *          one of Claude Code's own hints.
 */
export function readPromptBox(content: string): PromptBox {
  if (!content) return null;

  const lines = content.split('\n');
  const clean = lines.map(stripAnsi);
  const box = findPromptBox(clean);
  if (!box) return null;

  const region = lines.slice(box.topSepIdx + 1, box.bottomSepIdx);
  const cleanRegion = clean.slice(box.topSepIdx + 1, box.bottomSepIdx);
  if (region.length === 0) return null;

  // Question and permission dialogs reuse the ❯ marker for the highlighted
  // option — those numbered rows are not prompt text.
  if (cleanRegion.some((line) => /^\s*❯?\s*\d+\.\s/.test(line))) return null;
  if (!/^\s*[❯>]/.test(cleanRegion[0])) return null;

  const cells: Cell[] = [];
  region.forEach((line, i) => {
    const lineCells = scanCells(line);
    if (i === 0) {
      // Drop the marker and the single space after it.
      let start = 0;
      while (start < lineCells.length && /\s/.test(lineCells[start].ch)) start++;
      if (start < lineCells.length && /[❯>]/.test(lineCells[start].ch)) start++;
      if (start < lineCells.length && /[ \u00a0]/.test(lineCells[start].ch)) start++;
      cells.push(...lineCells.slice(start));
    } else {
      // Continuation lines carry a two-space hanging indent.
      cells.push({ ch: '\n', faint: false });
      cells.push(...lineCells.slice(lineCells.length >= 2 ? 2 : 0));
    }
  });

  const render = (kept: Cell[]) =>
    kept
      .map((c) => (c.ch === ' ' ? ' ' : c.ch))
      .join('')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();

  const typed = render(cells.filter((c) => !c.faint));
  if (typed) return { kind: 'typed', text: truncate(typed) };

  const ghost = render(cells);
  if (!ghost) return null;
  if (PROMPT_HINTS.some((hint) => hint.test(ghost))) return null;

  return { kind: 'suggestion', text: truncate(ghost) };
}

function truncate(text: string): string {
  return text.length > MAX_PROMPT_INPUT_CHARS ? text.slice(0, MAX_PROMPT_INPUT_CHARS) + '…' : text;
}

/** Max characters kept per queued message. */
const MAX_QUEUED_CHARS = 300;

/** Most queued messages carried to the UI; a longer queue is truncated. */
const MAX_QUEUED_MESSAGES = 10;

/** The background Claude Code paints behind a message waiting in its queue. */
const QUEUED_ROW_BG = "48;5;237";

/**
 * Read the messages waiting in Claude Code's own queue — what the user typed
 * into the pane while it was busy, which it will pick up turn by turn.
 *
 * They sit directly above the prompt box, indented two spaces, each row painted
 * with a background. A submitted message looks similar but starts at column 0,
 * which is what keeps scrollback out of the result.
 *
 * Needs a capture taken with `tmux capture-pane -e`; without escape codes there
 * is no background to match and the result is empty.
 *
 * @returns The queued messages, oldest first.
 */
export function readQueuedMessages(content: string): string[] {
  if (!content) return [];

  const lines = content.split('\n');
  const clean = lines.map(stripAnsi);
  const box = findPromptBox(clean);
  if (!box) return [];

  // Walk up from the prompt box; the queue is the unbroken run just above it.
  const rows: { text: string; starts: boolean }[] = [];
  for (let i = box.topSepIdx - 1; i >= 0; i--) {
    if (!lines[i].includes(QUEUED_ROW_BG)) break;
    const starts = /^ {2}[❯>] /.test(clean[i]);
    if (!starts && !/^ {2,}\S/.test(clean[i])) break;
    rows.push({ text: clean[i].replace(/^ {2}[❯>] /, '').replace(/^ +/, '').trimEnd(), starts });
    if (rows.length > MAX_QUEUED_MESSAGES * 4) break;
  }
  rows.reverse();

  const messages: string[] = [];
  for (const row of rows) {
    if (row.starts || messages.length === 0) messages.push(row.text);
    // A wrapped message continues on the next row.
    else messages[messages.length - 1] += ' ' + row.text;
  }

  return messages
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, MAX_QUEUED_MESSAGES)
    .map((m) => (m.length > MAX_QUEUED_CHARS ? m.slice(0, MAX_QUEUED_CHARS) + '…' : m));
}

/**
 * Detect if the pane shows user interruption or cancellation.
 * Only detects FRESH signals from the most recent interaction.
 *
 * Structure of Claude Code pane:
 *   ❯ user command           ← interaction start (● or ❯)
 *     ⎿  Interrupted...      ← signal we're looking for
 *   ─────────────────────    ← TOP separator
 *   ❯ [user input]           ← prompt area (may have text)
 *   ─────────────────────    ← BOTTOM separator
 *     status line
 *
 * Algorithm:
 * 1. Find the two separators around the prompt area
 * 2. Scan backwards from TOP separator to find ● or ❯ (interaction start)
 * 3. Check the slice between interaction start and TOP separator for signals
 *
 * @returns 'interrupted' if user pressed Esc during work,
 *          'declined' if user cancelled a prompt,
 *          null if no interruption detected
 */
export function detectRecentInterruption(content: string): 'interrupted' | 'declined' | null {
  if (!content) return null;

  const lines = content.split('\n');

  // If there's active UI (menu or working), don't detect old interruptions
  const bottomLines = lines.slice(-5).join('\n');
  if (
    bottomLines.includes('Esc to cancel') ||
    bottomLines.includes('Esc to interrupt') ||
    bottomLines.includes('ctrl+c to interrupt')
  ) {
    return null;
  }

  // The prompt box is bounded by the last two separators in the pane.
  const box = findPromptBox(lines);
  if (!box) return null;
  const { topSepIdx } = box;

  // Scan backwards from TOP separator to find the interaction start (● or ❯)
  let interactionStartIdx = -1;
  const maxScan = Math.max(0, topSepIdx - 15);
  for (let i = topSepIdx - 1; i >= maxScan; i--) {
    const line = lines[i];
    if (line.startsWith('●') || line.startsWith('❯')) {
      interactionStartIdx = i;
      break;
    }
  }
  if (interactionStartIdx === -1) return null;

  // Check the slice from interaction start to TOP separator for signals
  const slice = lines.slice(interactionStartIdx, topSepIdx).join('\n');

  if (slice.includes('Interrupted')) return 'interrupted';
  if (slice.includes('User declined to answer')) return 'declined';

  return null;
}

/**
 * Detect a Remote Control URL in pane content.
 * Strips ANSI escape codes before matching.
 * Returns the URL or null if not found.
 */
export function detectRemoteControlUrl(content: string): string | null {
  if (!content) return null;

  const clean = stripAnsi(content);

  // Match claude.ai/code URLs (RC session URLs). The dialog ends its sentence
  // with the URL, so a trailing full stop is prose, not part of the address.
  const match = clean.match(/https:\/\/claude\.ai\/code[^\s)\]>]*/);
  return match ? match[0].replace(/[.,;:]+$/, "") : null;
}

/**
 * Check if a tmux pane shows a recent interruption/cancellation.
 * Returns the session update to apply, or null if no update needed.
 *
 * @param tmuxTarget - The tmux target in format "session:window.pane"
 * @returns Session fields to update if interruption detected, null otherwise
 */
export function checkForInterruption(tmuxTarget: string): { state: 'idle'; current_action: null; prompt_text: null } | null {
  const content = capturePaneContent(tmuxTarget);
  if (!content) return null;

  const interruption = detectRecentInterruption(content);
  if (interruption) {
    return { state: 'idle', current_action: null, prompt_text: null };
  }
  return null;
}

/** Max options carried to the UI; a longer list is truncated. */
const MAX_PROMPT_OPTIONS = 10;

/** Max characters kept per option label. */
const MAX_OPTION_CHARS = 120;

/** How far up from the last content line an option run may start. */
const OPTION_RUN_WINDOW = 24;

/**
 * How far above the last content line the run may end. A dialog puts its
 * options at the foot, under at most a closing border and a hint.
 */
const OPTION_RUN_TAIL = 3;

/** One numbered choice Claude Code is offering in the pane. */
export type PromptOption = {
  /** The number you would type to pick it. */
  n: number;
  label: string;
  /**
   * The line the dialog prints under the label, indented beneath it. A
   * question's options are often too terse to choose between without it.
   */
  hint?: string;
  /** Whether a multi-select row's own checkbox is ticked. */
  checked?: boolean;
  /** Claude Code's own highlight — the row carrying the `❯` marker. */
  selected: boolean;
};

/** A numbered question waiting in the pane. */
export type PromptChoice = {
  question: string | null;
  options: PromptOption[];
  /**
   * The rows carry checkboxes: picking one ticks it and leaves the dialog
   * open, and the answer is sent from a tab of its own.
   */
  multi?: boolean;
  /**
   * The highlighted row is a text field: the "Type something" option has been
   * picked and keystrokes now go into it rather than driving the list. Enter
   * submits a single-select answer; in a multi-select it toggles the row's own
   * box, and the arrows have to leave the row before Right can reach Submit.
   */
  typing?: boolean;
  /**
   * The text field open for typing is the highlighted option's notes, not
   * the option itself: `n` opened it, Escape closes it and keeps the note,
   * and Enter would submit the dialog with the note and no option picked.
   */
  noting?: boolean;
  /**
   * The line the dialog draws under itself naming the keys it answers to, as
   * printed — "Enter to set as default · s to use this session only · …". Set
   * only when the pane drew one.
   */
  keys?: string;
  /**
   * Lines the dialog prints between its last row and the key hint: a setting
   * the same dialog adjusts with other keys, such as the model picker's
   * "● High effort (default) ←/→ to adjust".
   */
  notes?: string[];
} | null;

/** How the caller wants an undeclared run — one with no key hint — treated. */
export type ReadPromptOptionsMode = {
  /**
   * Accept only a dialog that names its own keys on its last line. The hooks
   * say nothing about a dialog a local command opens (`/model`, `/config`) —
   * the session stays `idle` — so for those the pane's own word is the gate,
   * and a bare numbered list at the foot of an idle pane must stay prose.
   */
  declaredOnly?: boolean;
};

const OPTION_ROW = /^(❯|>)?\s*(\d+)[.)]\s+(\S.*)$/;

/** A line that only rules off one part of a dialog from another. */
const OPTION_RULE = /^[─━╌┄┈—–-]+$/;

/**
 * The line Claude Code draws under a dialog, naming the keys that drive it.
 *
 * It is the pane saying outright that what sits above is a dialog, which is
 * worth more than any guess from shape: with it there, the rows may sit well
 * above the foot behind a preview panel, and anything at all may separate
 * them. Without it the scan stays strict, because then a numbered list in
 * prose and a dialog really do look alike.
 */
const DIALOG_HINT = /↑\/↓|Enter to (?:select|confirm)|Esc to cancel/;

/**
 * The key the hint adds while a "Type something" row is open for typing. It
 * is the only visible difference between a list and a list with a text field
 * in it, and it decides whether keystrokes drive the rows or fill the field.
 */
const TYPING_HINT = /ctrl\+g to edit/i;

/** The notes line a question with previews draws under its rows. */
const NOTES_LINE = /^Notes:/;

/** That line while the notes field is closed: it only says how to open it. */
const NOTES_CLOSED = /press n to add notes/i;

/**
 * The tab strip a question draws above itself — "←  ☐ Fruits  ✔ Submit  →",
 * or just "☐ Color" for a single question. It sits directly over the question
 * with no blank line between, so the walk that finds the question has to know
 * it is not part of it.
 */
const TAB_STRIP = /^(?:←\s+)?[☐☒☑✔✓]\s/;

/**
 * A row that carries its description on its own line, after a run of spaces:
 * "Default (recommended)  Opus 5 with 1M context · Best for everyday…". The
 * model picker draws its rows that way; a question puts the description on
 * the line below instead.
 */
const INLINE_HINT = /^(.*?\S)\s{2,}(\S.*)$/;

/** A preview panel drawn to the right shares its lines with the rows. */
const PREVIEW_COLUMN = /\s{2,}[┌┐└┘├┤─━│╭╮╰╯].*$/;

/** A line that is drawing a box rather than saying anything. */
const BOX_ROW = /^[┌┐└┘├┤─━│╭╮╰╯]/;

/** A multi-select row carries its own state in a checkbox. */
const CHECKBOX = /^\[([ xX✔✓])\]\s*/;

/** How far past its row a description may be indented and still be one. */
const HINT_INDENT_SPAN = 8;

/**
 * A pane line's content and how far it is indented, with the frame off.
 *
 * The indent is what separates an option's own description from the question
 * above it: both are prose, and only the description sits under its row.
 */
function bodyOf(line: string): { indent: number; text: string } {
  const body = (line ?? "").replace(/[\s│┃|╎┆┊]+$/, "").replace(/^\s*[│┃|╎┆┊]+/, "");
  const text = body.trimStart();
  return { indent: body.length - text.length, text };
}

/** Keep a dialog's own words, but not a paragraph of them. */
function clampOption(text: string): string {
  return text.length > MAX_OPTION_CHARS ? text.slice(0, MAX_OPTION_CHARS) + "…" : text;
}

/**
 * Read the numbered options of a permission or question dialog.
 *
 * Deliberately layout-agnostic: rather than locating Claude Code's dialog
 * frame, it scans the foot of the pane for the last run of numbered rows.
 * That survives a change to the box drawing, which locating the frame would
 * not — and the run has to number 1, 2, 3… without a gap, which is what keeps
 * an ordinary numbered list in Claude's prose from matching.
 *
 * The rows need not be adjacent. A permission dialog's are, but a question's
 * carry a description under each label and a rule above the last row, and
 * requiring adjacency is what used to make every question unanswerable from
 * anywhere but the pane itself. Only three things may sit between two rows —
 * a blank line, a rule, and a line indented past the row below it, which is
 * how a description is told apart from the question.
 *
 * Callers must still gate on session state: the hooks are authoritative for
 * whether a dialog is actually open, and this only says what it looks like.
 *
 * @param content Pane text with the ANSI already stripped — the session poll
 *                strips once per tick and hands that copy to every check.
 * @param mode    `declaredOnly` when the hooks do not vouch for a dialog.
 * @returns null when no run qualifies.
 */
export function readPromptOptions(content: string, mode: ReadPromptOptionsMode = {}): PromptChoice {
  if (!content) return null;

  // Only the foot of the pane is ever inspected, so the frame comes off line
  // by line inside the bounded scan rather than across the whole capture.
  const raw = content.split("\n");
  const seen = new Map<number, { indent: number; text: string }>();
  const at = (i: number): { indent: number; text: string } => {
    let line = seen.get(i);
    if (line === undefined) {
      line = bodyOf(raw[i]);
      seen.set(i, line);
    }
    return line;
  };

  let lastContent = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (at(i).text.length > 0) {
      lastContent = i;
      break;
    }
  }
  if (lastContent === -1) return null;

  // A dialog says so on its last line. Where it does, the rows are allowed to
  // sit well above the foot — a preview panel is drawn under them, and so is
  // the row that offers to talk about the question instead. Where it does
  // not, they have to be at the foot, under at most a closing border.
  const hintLine = at(lastContent).text;
  const declared = DIALOG_HINT.test(hintLine);
  if (mode.declaredOnly && !declared) return null;
  const reach = declared ? OPTION_RUN_WINDOW : OPTION_RUN_TAIL;

  let end = -1;
  for (let i = lastContent; i >= Math.max(0, lastContent - reach); i--) {
    if (OPTION_ROW.test(at(i).text)) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  // Walk up counting down: n, n-1, … 1. Between two rows a dialog may print
  // the option's own description, a rule, or nothing, so those are stepped
  // over — but anything else ends the run, which is what stops the walk at
  // the question and keeps a numbered list in prose from matching.
  const floor = Math.max(0, lastContent - OPTION_RUN_WINDOW);
  const rows: { i: number; n: number; label: string; selected: boolean; indent: number }[] = [];
  let expected = -1;
  for (let i = end; i >= floor; i--) {
    const { indent, text } = at(i);
    const m = text.match(OPTION_ROW);
    if (m) {
      const n = Number(m[2]);
      if (expected !== -1 && n !== expected) break;
      // The highlight marker takes the two columns the other rows fill with
      // spaces, so the row's indent is where its number starts, not where
      // the marker does — the description under it lines up with the rest.
      rows.push({ i, n, label: m[3], selected: m[1] === "❯", indent: m[1] ? indent + 2 : indent });
      expected = n - 1;
      if (n === 1) break;
      continue;
    }
    if (declared) continue;
    if (text.length === 0 || OPTION_RULE.test(text)) continue;
    // A description belongs to the row below it, so it is indented past it.
    const below = rows[rows.length - 1];
    if (below && indent > below.indent) continue;
    break;
  }
  rows.reverse();

  if (rows.length < 2 || rows.length > MAX_PROMPT_OPTIONS) return null;
  if (rows[0].n !== 1) return null;

  let multi = false;
  // Lines under the last row that turn out not to be its description.
  const notes: string[] = [];
  const options: PromptOption[] = rows.map((row, k) => {
    // A preview panel shares the row's line, so the label stops where it does.
    const preview = PREVIEW_COLUMN.test(row.label);
    let label = row.label.replace(PREVIEW_COLUMN, "").trimEnd();
    const box = label.match(CHECKBOX);
    if (box) {
      multi = true;
      label = label.slice(box[0].length);
    }
    const last = k + 1 === rows.length;

    // The line under a row is the option's own description — unless a preview
    // panel is drawn beside it, in which case the left column is narrow, the
    // description is not drawn at all, and what sits there is the rest of a
    // label too long for one line. A description is indented at least as far
    // as its row and not much further; the rule that closes the run closes
    // the search with it.
    // Under the last row the search runs to the key hint, which is not a
    // description of anything; the rows before it stop at the next row.
    const stop = last ? (declared ? lastContent : lastContent + 1) : rows[k + 1].i;
    const noting = last && declared;
    let hint: string | undefined;
    // A rule closes the run, and the description search with it.
    let ruled = false;
    for (let i = row.i + 1; i < stop; i++) {
      const { indent, text } = at(i);
      if (OPTION_RULE.test(text)) {
        if (!noting) break;
        ruled = true;
        continue;
      }
      if (!text || BOX_ROW.test(text)) continue;
      const bare = text.replace(PREVIEW_COLUMN, "").trimEnd();
      if (!bare) continue;
      const under =
        !ruled && indent >= row.indent && indent <= row.indent + HINT_INDENT_SPAN;
      if (!under || hint !== undefined) {
        // Not this row's description. Under the last row of a declared dialog
        // that makes it a note the dialog is printing for itself — unless a
        // rule has already closed the run, past which only the dialog's own
        // unnumbered rows ("Chat about this") are drawn.
        if (noting && !ruled) notes.push(clampOption(bare));
        continue;
      }
      if (preview) {
        label = `${label} ${bare}`;
        continue;
      }
      hint = clampOption(bare);
    }

    // The model picker writes the description on the row itself, after a run
    // of spaces; a question never does, and a preview row's spaces were the
    // panel, which is already gone.
    if (hint === undefined && !preview) {
      const inline = label.match(INLINE_HINT);
      if (inline) {
        label = inline[1];
        hint = clampOption(inline[2]);
      }
    }

    return {
      n: row.n,
      label: clampOption(label),
      hint,
      checked: box ? box[1] !== " " : undefined,
      selected: row.selected,
    };
  });

  // The question is in the paragraph directly above the run: the line that
  // asks it when one does, else the paragraph's first line, which is the
  // title a dialog such as the model picker leads with. The paragraph ends at
  // a blank line, a rule, or the tab strip a question draws over itself.
  let question: string | null = null;
  let top: string | null = null;
  for (let i = rows[0].i - 1; i >= 0 && i >= rows[0].i - 4; i--) {
    const { text } = at(i);
    if (/^[─━╌┄┈╭╮╰╯]+$/.test(text) || TAB_STRIP.test(text)) break;
    if (!text) {
      if (top !== null) break;
      continue;
    }
    top = text;
    if (text.endsWith("?")) {
      question = clampOption(text);
      break;
    }
  }
  if (question === null && top !== null) question = clampOption(top);

  const choice: NonNullable<PromptChoice> = { question, options };
  if (multi) choice.multi = true;
  if (declared) {
    choice.keys = clampOption(hintLine);
    if (TYPING_HINT.test(hintLine)) {
      choice.typing = true;
      // With the notes field open its line reads "Notes: <text>" or the
      // placeholder; closed, it says how to open it. Only the open field
      // takes what is typed.
      if (notes.some((note) => NOTES_LINE.test(note) && !NOTES_CLOSED.test(note))) {
        choice.noting = true;
      }
    }
    if (notes.length > 0) choice.notes = notes;
  }
  return choice;
}
