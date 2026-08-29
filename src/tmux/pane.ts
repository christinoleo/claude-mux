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
export async function getAllPaneTitles(): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const stdout = await hardTimeout(
    execFileAsync("tmux", [
      "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\t#{pane_title}"
    ], { encoding: "utf-8", timeout: 2000 }).then((r) => r.stdout),
    2500,
    "",
  );
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    const target = line.slice(0, tabIdx);
    const title = line.slice(tabIdx + 1).trim();
    result.set(target, title || null);
  }
  return result;
}

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
      if (start < lineCells.length && /[  ]/.test(lineCells[start].ch)) start++;
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

  // Match claude.ai/code URLs (RC session URLs)
  const match = clean.match(/https:\/\/claude\.ai\/code[^\s)\]>]*/);
  return match ? match[0] : null;
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
  /** Claude Code's own highlight — the row carrying the `❯` marker. */
  selected: boolean;
};

/** A numbered question waiting in the pane. */
export type PromptChoice = { question: string | null; options: PromptOption[] } | null;

/** Drop a box-drawing frame and padding from both ends of a pane line. */
function unframe(line: string): string {
  return line.replace(/^[\s│┃|╎┆┊]+/, "").replace(/[\s│┃|╎┆┊]+$/, "");
}

const OPTION_ROW = /^(❯|>)?\s*(\d+)[.)]\s+(\S.*)$/;

/**
 * Read the numbered options of a permission or question dialog.
 *
 * Deliberately layout-agnostic: rather than locating Claude Code's dialog
 * frame, it scans the foot of the pane for the last contiguous run of numbered
 * rows. That survives a change to the box drawing, which locating the frame
 * would not — and the run has to number 1, 2, 3… without a gap, which is what
 * keeps an ordinary numbered list in Claude's prose from matching.
 *
 * Callers must still gate on session state: the hooks are authoritative for
 * whether a dialog is actually open, and this only says what it looks like.
 *
 * @param content Pane text with the ANSI already stripped — the session poll
 *                strips once per tick and hands that copy to every check.
 * @returns null when no run qualifies.
 */
export function readPromptOptions(content: string): PromptChoice {
  if (!content) return null;

  // Only the foot of the pane is ever inspected, so the frame comes off line
  // by line inside the bounded scan rather than across the whole capture.
  const raw = content.split("\n");
  const seen = new Map<number, string>();
  const at = (i: number): string => {
    let line = seen.get(i);
    if (line === undefined) {
      line = unframe(raw[i]);
      seen.set(i, line);
    }
    return line;
  };

  let lastContent = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (at(i).length > 0) {
      lastContent = i;
      break;
    }
  }
  if (lastContent === -1) return null;

  // Walk up from the foot to find the end of the run, then its start.
  let end = -1;
  for (let i = lastContent; i >= Math.max(0, lastContent - OPTION_RUN_WINDOW); i--) {
    if (OPTION_ROW.test(at(i))) {
      end = i;
      break;
    }
  }
  if (end === -1 || lastContent - end > OPTION_RUN_TAIL) return null;

  // Floored at the cap: a longer run is rejected anyway, so there is no reason
  // to walk it to the top of the pane and build objects that get thrown away.
  const floor = Math.max(0, end - MAX_PROMPT_OPTIONS);
  let start = end;
  while (start - 1 >= floor && OPTION_ROW.test(at(start - 1))) start--;
  if (start === floor && floor > 0 && OPTION_ROW.test(at(floor))) return null;

  const options: PromptOption[] = [];
  for (let i = start; i <= end; i++) {
    const m = at(i).match(OPTION_ROW);
    if (!m) return null;
    options.push({
      n: Number(m[2]),
      label: m[3].length > MAX_OPTION_CHARS ? m[3].slice(0, MAX_OPTION_CHARS) + "…" : m[3],
      selected: m[1] === "❯",
    });
  }

  // A real dialog numbers 1, 2, 3… with no gap. Anything else is prose.
  if (options.length < 2 || options.length > MAX_PROMPT_OPTIONS) return null;
  if (options.some((o, i) => o.n !== i + 1)) return null;

  // The question is the nearest line above the run that isn't blank.
  let question: string | null = null;
  for (let i = start - 1; i >= 0 && i >= start - 4; i--) {
    const text = at(i);
    if (!text) continue;
    if (/^[─━╌┄┈╭╮╰╯]+$/.test(text)) break;
    question = text.length > MAX_OPTION_CHARS ? text.slice(0, MAX_OPTION_CHARS) + "…" : text;
    break;
  }

  return { question, options };
}
