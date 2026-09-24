/**
 * A grilling round, read out of Claude's reply so it can be answered as a form.
 *
 * The grilling skill asks a whole round of questions at once, each in the
 * same shape, with its own recommendation under it:
 *
 *     ❓ **Q1** - **Storage**: Where do drafts live?
 *
 *     ➡️ In the session JSON, next to the rest of the live state.
 *
 * Answering that in a text box means retyping "Q1: yes, Q2: …" for every
 * question, most of which you agree with. Read as a round, each question
 * becomes a row you accept with one tap or answer in your own words, and the
 * reply is written for you.
 */

export interface GrillQuestion {
  /** The number Claude gave it: Q3 is 3. */
  n: number;
  /** The bold title after the number, when the question has one. */
  title: string | null;
  /** The question itself, as markdown. */
  body: string;
  /** Claude's recommended answer, as markdown; null when it offered none. */
  recommended: string | null;
}

export interface GrillRound {
  /** Whatever Claude wrote before the first question. */
  intro: string;
  questions: GrillQuestion[];
  /** Whatever it wrote after the last question's recommendation. */
  outro: string;
}

export type GrillAnswer = { mode: "accept" } | { mode: "own"; text: string } | { mode: "skip" };

/** `❓ **Q1** - **Title**: body`, or `❓ **Q1 - Title**: body`. */
const QUESTION = /^\s*❓️?\s*\*\*Q(\d+)(?:\s*[-–—:.]\s*([^*]+?))?\*\*\s*[-–—:.]?\s*(?:\*\*([^*]+?)\*\*\s*:?)?\s*(.*)$/;
const RECOMMENDED = /^\s*➡️?\s*(.*)$/;

/** Splits text at blank lines into its first paragraph and the rest. */
function firstParagraph(lines: string[]): [string[], string[]] {
  const blank = lines.findIndex((l) => l.trim() === "");
  return blank === -1 ? [lines, []] : [lines.slice(0, blank), lines.slice(blank + 1)];
}

function join(lines: string[]): string {
  return lines.join("\n").trim();
}

/** The round in `text`, or null when it asks no numbered questions. */
export function parseGrillRound(text: string): GrillRound | null {
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (QUESTION.test(line)) starts.push(i);
  });
  if (starts.length === 0) return null;

  const intro = join(lines.slice(0, starts[0]));
  const questions: GrillQuestion[] = [];
  let outro = "";

  starts.forEach((start, qi) => {
    const end = starts[qi + 1] ?? lines.length;
    const m = lines[start].match(QUESTION)!;
    const rest = lines.slice(start + 1, end);
    const recAt = rest.findIndex((l) => RECOMMENDED.test(l));
    const bodyLines = [m[4], ...(recAt === -1 ? rest : rest.slice(0, recAt))];

    let recommended: string | null = null;
    if (recAt !== -1) {
      const recLines = [rest[recAt].match(RECOMMENDED)![1], ...rest.slice(recAt + 1)];
      const [para, after] = firstParagraph(recLines);
      recommended = join(para) || null;
      // Past the last question, what follows the recommendation is Claude
      // talking to you again, not part of the answer it proposed.
      if (qi === starts.length - 1) outro = join(after);
      else if (join(after)) recommended = join(recLines);
    }

    questions.push({
      n: Number(m[1]),
      title: (m[2] ?? m[3])?.trim() || null,
      body: join(bodyLines),
      recommended,
    });
  });

  return { intro, questions, outro };
}

/**
 * The reply a round's answers make, one line per question in Claude's order.
 * A skipped question is said to be skipped, so Claude knows it is still open
 * rather than guessing it was agreed.
 */
export function composeGrillReply(round: GrillRound, answers: Record<number, GrillAnswer>): string {
  return round.questions
    .map((q) => {
      const label = q.title ? `Q${q.n} (${q.title})` : `Q${q.n}`;
      const answer = answers[q.n] ?? (q.recommended ? { mode: "accept" } : { mode: "skip" });
      if (answer.mode === "accept") return `${label}: agreed, go with your recommendation.`;
      if (answer.mode === "skip" || !answer.text.trim()) return `${label}: skip for now, leave it open.`;
      return `${label}: ${answer.text.trim()}`;
    })
    .join("\n");
}
