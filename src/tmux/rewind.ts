/**
 * Claude Code's rewind, as the pane draws it.
 *
 * Esc Esc (or /rewind) opens it in two steps, neither of which reaches the
 * transcript. First a list of the prompts the conversation can go back to,
 * oldest at the top, each with the files its turn changed and a last row
 * "(current)" where the selection starts; the list scrolls, saying how many
 * rows sit above and below. Then, for the prompt picked, a confirmation that
 * quotes it, says what the highlighted choice would do to the conversation
 * and the code, and offers the choices by number, which a digit picks at once.
 */

export type RewindRow = {
  /** The prompt's first line, cut with "…" where there was more. */
  text: string;
  /** "a.txt +1", "No code changes"; null for the "(current)" row. */
  files: string | null;
  selected: boolean;
  /** The "(current)" row: the conversation as it stands. */
  current: boolean;
};

export type RewindOption = { n: number; label: string; selected: boolean };

export type RewindScreen =
  | { step: "list"; rows: RewindRow[]; above: number; below: number }
  | {
      step: "confirm";
      /** The prompt it would go back to before, every line of it. */
      prompt: string;
      /** "40s ago", as the quote ends. */
      ago: string | null;
      /** What the highlighted choice does: "The conversation will be forked.", "The code will be restored -1 in a.txt." */
      effects: string[];
      /** The choices on screen; the list scrolls, so the last may be hidden. */
      options: RewindOption[];
    }
  | null;

/** The choices Claude Code offers, by the label it gives them. */
export const REWIND_CHOICES = [
  "Restore code and conversation",
  "Restore conversation",
  "Restore code",
  "Summarize from here",
  "Summarize up to here",
] as const;
export type RewindChoice = (typeof REWIND_CHOICES)[number];

const HEADER = /^\s*Rewind\s*$/;
const LIST_LEAD = /^\s*Restore the code and\/or conversation to the point before/;
const CONFIRM_LEAD = /^\s*Confirm you want to restore to the point before/;
const LIST_FOOT = /Enter to continue · Esc to cancel/;
const MORE = /^\s*([↑↓])\s+(\d+) more\s*$/;
const SELECTED = /^(\s*)❯\s/;
const QUOTE = /^\s*│\s?(.*?)\s*$/;
const AGO = /^\((.+ ago)\)$/;
const EFFECT = /^\s*(The (?:conversation|code) will .+?)\s*$/;
const OPTION = /^\s*(❯|↑|↓)?\s*(\d+)\.\s+(.+?)\s*$/;

/** How far up from the foot the dialog may begin. */
const REACH = 60;

/** Read the rewind dialog off a pane capture taken without colour. */
export function readRewindScreen(content: string): RewindScreen {
  if (!content || !content.includes("Rewind")) return null;
  const lines = content.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  for (let i = last; i >= Math.max(0, last - REACH); i--) {
    if (!HEADER.test(lines[i])) continue;
    let lead = i + 1;
    while (lead <= last && !lines[lead].trim()) lead++;
    if (LIST_LEAD.test(lines[lead] ?? "")) return readList(lines.slice(lead + 1, last + 1));
    if (CONFIRM_LEAD.test(lines[lead] ?? "")) return readConfirm(lines.slice(lead + 1, last + 1));
    return null;
  }
  return null;
}

function readList(lines: string[]): RewindScreen {
  const rows: RewindRow[] = [];
  let above = 0;
  let below = 0;
  // A row is its prompt line and, under it, the line naming its files; a
  // blank line ends it.
  let open: RewindRow | null = null;
  for (const line of lines) {
    if (LIST_FOOT.test(line)) break;
    const more = line.match(MORE);
    if (more) {
      if (more[1] === "↑") above = Number(more[2]);
      else below = Number(more[2]);
      open = null;
      continue;
    }
    if (!line.trim()) {
      open = null;
      continue;
    }
    if (open && open.files === null && !open.current) {
      open.files = line.trim();
      continue;
    }
    const selected = SELECTED.test(line);
    const text = line.replace(SELECTED, "$1").trim();
    open = { text, files: null, selected, current: text === "(current)" };
    rows.push(open);
  }
  return rows.length > 0 ? { step: "list", rows, above, below } : null;
}

function readConfirm(lines: string[]): RewindScreen {
  const quote: string[] = [];
  const effects: string[] = [];
  const options: RewindOption[] = [];
  for (const line of lines) {
    const option = line.match(OPTION);
    if (option) {
      options.push({ n: Number(option[2]), label: option[3], selected: option[1] === "❯" });
      continue;
    }
    const effect = line.match(EFFECT);
    if (effect) {
      effects.push(effect[1]);
      continue;
    }
    const q = options.length === 0 && effects.length === 0 ? line.match(QUOTE) : null;
    if (q) quote.push(q[1]);
  }
  if (options.length === 0) return null;
  const ago = quote.length > 0 ? (quote[quote.length - 1].match(AGO)?.[1] ?? null) : null;
  if (ago) quote.pop();
  return { step: "confirm", prompt: quote.join("\n"), ago, effects, options };
}

function normal(text: string): { text: string; cut: boolean } {
  const trimmed = text.split("\n", 1)[0].trim();
  const cut = /(…|\.\.\.)$/.test(trimmed);
  return { text: trimmed.replace(/(…|\.\.\.)$/, "").replace(/\s+/g, " ").trim(), cut };
}

/**
 * Whether two renderings of a prompt are the same prompt: a row of the list,
 * the quote in the confirmation, the transcript's text. The list shows a
 * prompt's first line only, cut with "…" where there was more or where it ran
 * past the pane's width, so a cut one need only start the other.
 */
export function isSamePrompt(shown: string, prompt: string): boolean {
  const a = normal(shown);
  const b = normal(prompt);
  if (!a.text || !b.text) return false;
  return a.text === b.text || (a.cut && b.text.startsWith(a.text)) || (b.cut && a.text.startsWith(b.text));
}

/** What the transcript asks the rewind route to do. */
export type RewindAction =
  | { action: "open"; prompt: string; back: number | null }
  | { action: "choose"; choice: RewindChoice }
  | { action: "cancel" };
