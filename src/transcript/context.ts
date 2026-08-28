/**
 * Context-window accounting for a session.
 *
 * Claude Code never writes a percentage anywhere we can read, but it does
 * write the raw `usage` of every API response into the transcript, and the
 * arithmetic behind its own status line is simple enough to mirror: the
 * tokens occupying the window are the input tokens plus both cache counters
 * of the most recent response, measured against the model's window.
 */

import { asRecord, readNumber, readString } from "./json.js";

const WINDOW_200K = 200_000;
const WINDOW_1M = 1_000_000;

/**
 * Windows by model, keyed on the id Claude Code writes into the transcript.
 * A provider may wrap that id ("us.anthropic.claude-opus-5-v1:0"), so the
 * known names are matched as substrings.
 *
 * A model in neither list stays unknown rather than being assumed: this table
 * ages against a Claude Code that upgrades on its own schedule, and a 540k
 * context reported as 270% of a guessed window is worse than no percentage.
 */
const WINDOWS: { window: number; models: string[] }[] = [
  {
    window: WINDOW_1M,
    models: [
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-fable-5",
      "claude-mythos-5",
    ],
  },
  {
    window: WINDOW_200K,
    models: [
      "claude-3-",
      "claude-haiku-4-5",
      "claude-sonnet-4-0",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-0",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
    ],
  },
];

export interface ContextUsage {
  /** Model that served the response, as written in the transcript. */
  model: string;
  /** Tokens occupying the context window on the last API call. */
  tokens: number;
  /** That model's window in tokens, or null when the model is unknown. */
  window: number | null;
}

export function contextWindowFor(model: string): number | null {
  const id = model.toLowerCase();
  // The `[1m]` suffix is the explicit opt-in offered for models that reach a
  // 1M window without having one natively.
  if (id.includes("[1m]")) return WINDOW_1M;
  for (const entry of WINDOWS) {
    if (entry.models.some((known) => id.includes(known))) return entry.window;
  }
  return null;
}

/** Share of the window in use, or null when the window is unknown. */
export function contextPercent(usage: ContextUsage): number | null {
  return usage.window === null ? null : Math.round((usage.tokens / usage.window) * 100);
}

/** Read the context usage off an assistant record's `message`. */
export function readContextUsage(message: Record<string, unknown>): ContextUsage | null {
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const tokens =
    readNumber(usage, "input_tokens") +
    readNumber(usage, "cache_creation_input_tokens") +
    readNumber(usage, "cache_read_input_tokens");
  // Synthetic messages never reached the API and carry a zeroed usage, which
  // would otherwise read as a context that had just emptied itself.
  if (tokens === 0) return null;
  const model = readString(message.model) ?? "";
  return { model, tokens, window: contextWindowFor(model) };
}
