/**
 * Pure reader for the token usage Claude Code writes into its JSONL
 * transcripts. Nothing here touches the filesystem; callers stream lines in.
 */

import { asRecord, readNumber, readString } from "../transcript/json.js";
import type { TokenTotals } from "./pricing.js";

export interface UsageRecord {
  timestampMs: number;
  model: string;
  sessionId: string;
  /** Launch directory, written on every assistant record. */
  cwd: string;
  totals: TokenTotals;
  reportedCostUsd: number | null;
  /**
   * `message.id`:`requestId`, the pair ccusage keys on.
   *
   * Claude Code writes one record per assistant content block and repeats the
   * parent message's whole `usage` object in each. Summing the records without
   * dropping repeats overcounts by ~2.2x on a real history.
   */
  dedupeKey: string | null;
}

function parseTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Non-negative integer, the sane floor for a token counter. */
function tokens(record: Record<string, unknown>, key: string): number {
  const value = readNumber(record, key);
  return value > 0 ? Math.trunc(value) : 0;
}

/**
 * Reads one transcript line, or null when it carries no usage.
 *
 * `server_tool_use.web_search_requests` is deliberately not read: Anthropic
 * bills web search per query on top of tokens, but the counter is zero across
 * the whole local history, so carrying an unpriced field through every layer
 * buys nothing. Revisit if it ever goes non-zero.
 */
export function parseUsageLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record || record.type !== "assistant") return null;

  const message = asRecord(record.message);
  if (!message) return null;
  const usage = asRecord(message.usage);
  if (!usage) return null;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;

  const model = readString(message.model) ?? "";
  if (model.length === 0) return null;

  // The flat counter is authoritative; the nested breakdown only says how much
  // of it used the 1-hour TTL, which bills at twice the 5-minute rate. Clamped
  // so a malformed breakdown can never exceed the total it splits.
  const creation = tokens(usage, "cache_creation_input_tokens");
  const breakdown = asRecord(usage.cache_creation);
  const oneHour = breakdown
    ? Math.min(tokens(breakdown, "ephemeral_1h_input_tokens"), creation)
    : 0;

  const output = tokens(usage, "output_tokens");
  const details = asRecord(usage.output_tokens_details);
  const thinking = details ? Math.min(tokens(details, "thinking_tokens"), output) : 0;

  const messageId = readString(message.id);
  const requestId = readString(record.requestId);
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const reported = record.costUSD;

  return {
    timestampMs,
    model,
    sessionId: readString(record.sessionId) ?? "",
    cwd: readString(record.cwd) ?? "",
    totals: {
      uncachedInput: tokens(usage, "input_tokens"),
      cacheRead: tokens(usage, "cache_read_input_tokens"),
      cacheCreation5m: creation - oneHour,
      cacheCreation1h: oneHour,
      output,
      thinking,
    },
    reportedCostUsd: typeof reported === "number" && Number.isFinite(reported) ? reported : null,
    dedupeKey,
  };
}
