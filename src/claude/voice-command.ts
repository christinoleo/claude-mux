/**
 * Turn a spoken slash command into a real one.
 *
 * Voice transcription hands us prose: "Barra model, opus." or "Slash code
 * review". When the transcript *starts* with a trigger word — "barra" (pt),
 * "slash" (en), or a literal "/" the model wrote itself — the words after it
 * are matched against the commands Claude Code actually has (same ranking as
 * the web command list: fuzzy on the name, substring on the description) and
 * the winner replaces them. Words the match does not consume stay as the
 * command's arguments.
 *
 * A trigger anywhere else in the sentence is left alone: only the user
 * opening with it signals intent, and "a barra de rolagem" must not become a
 * command.
 */
import { fuzzyScore } from "../utils/fuzzy.js";
import { scoreCommand, type DiscoveredCommand } from "./commands.js";

export interface SpokenCommandResult {
  /** Text to inject — the original transcript when no command matched. */
  text: string;
  /** The command that was substituted in, if any. */
  command: DiscoveredCommand | null;
}

const TRIGGER_WORDS = new Set(["barra", "slash"]);

/** Most words a spoken command name can span ("code review", "ak linus"). */
const MAX_COMMAND_WORDS = 4;

/** Strip punctuation the transcriber glues onto spoken words. */
function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * A Portuguese transcriber hears "model" and writes "modelo", "clear" and
 * writes "clara". Dropping a final vowel recovers the English stem for most
 * of these, so every query is also tried with each word stemmed.
 */
function stemWord(word: string): string {
  return word.length > 3 ? word.replace(/[aeiou]$/i, "") : word;
}

/** The joined query and its stemmed variant (scoring a duplicate is harmless). */
function queryVariants(words: string[]): string[] {
  return [words.join(""), words.map(stemWord).join("")];
}

/**
 * Whether the transcript opens with a trigger at all — the cheap pre-check
 * that lets the caller skip the command-discovery scan for ordinary prose.
 */
export function hasSpokenCommandTrigger(text: string): boolean {
  const first = cleanWord(text.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
  return TRIGGER_WORDS.has(first) || (first.startsWith("/") && first.length > 1);
}

export function resolveSpokenCommand(
  text: string,
  commands: DiscoveredCommand[]
): SpokenCommandResult {
  const unchanged: SpokenCommandResult = { text, command: null };
  const words = text.trim().split(/\s+/);
  if (words.length === 0 || commands.length === 0) return unchanged;

  const first = cleanWord(words[0]).toLowerCase();
  let queryStart: number;
  if (TRIGGER_WORDS.has(first)) {
    queryStart = 1;
  } else if (first.startsWith("/") && first.length > 1) {
    // The transcriber already wrote "/model" — still resolve it, so a
    // mis-heard "/módel" lands on the real command.
    queryStart = 0;
    words[0] = first.slice(1);
  } else {
    return unchanged;
  }

  const queryWords = words.slice(queryStart).map(cleanWord).filter(Boolean);
  if (queryWords.length === 0) return unchanged;

  // Try consuming 1..N words as the command name; spoken separators vanish
  // when joined ("code review" → "codereview"), which the subsequence match
  // sees straight through "/code-review".
  let best: { command: DiscoveredCommand; score: number; consumed: number } | null = null;
  const maxWords = Math.min(MAX_COMMAND_WORDS, queryWords.length);
  for (let n = 1; n <= maxWords; n++) {
    for (const query of queryVariants(queryWords.slice(0, n))) {
      for (const cmd of commands) {
        const score = scoreCommand(cmd, query);
        if (score != null && (best == null || score > best.score)) {
          best = { command: cmd, score, consumed: n };
        }
      }
    }
  }
  if (best == null) return unchanged;

  // Greedy extension: "barra code review" scores best as "code" alone (a
  // substring beats a subsequence), leaving "review" behind as an argument.
  // If the next word joined on still matches the winner's *name*, it was part
  // of the spoken command, not an argument.
  let consumed = best.consumed;
  while (consumed < maxWords) {
    const variants = queryVariants(queryWords.slice(0, consumed + 1));
    if (!variants.some((q) => fuzzyScore(best!.command.name, q) != null)) break;
    consumed++;
  }

  const args = queryWords.slice(consumed).join(" ");
  return {
    text: args ? `${best.command.insert} ${args}` : best.command.insert,
    command: best.command,
  };
}
