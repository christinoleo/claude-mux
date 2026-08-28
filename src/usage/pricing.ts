/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json` — the same
 * table ccusage prices against. Everything here is pure; fetching and caching
 * the document lives in `rate-table.ts`.
 *
 * The cost this produces is what the same tokens would have cost on the API.
 * A Max subscription is not billed this way, so the number is for comparing
 * projects and models against each other, never for reconciling an invoice.
 */

import { asRecord } from "../transcript/json.js";
import { FALLBACK_RATES } from "./fallback-rates.js";

/** All rates are USD per token. */
export interface ModelRate {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheWrite5mPerToken: number;
  cacheWrite1hPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/**
 * Tokens of one API response, already split by how each part is billed.
 *
 * Anthropic reports `input_tokens` exclusive of both cache counters, so the
 * four billable fields sum to the whole request without double counting.
 */
export interface TokenTotals {
  uncachedInput: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  output: number;
  /** Subset of `output`. Reported for the breakdown, never priced again. */
  thinking: number;
}

export const EMPTY_TOTALS: TokenTotals = {
  uncachedInput: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  output: 0,
  thinking: 0,
};

/** Adds `b` into `a` in place. For private accumulators only. */
export function addInto(a: TokenTotals, b: TokenTotals): void {
  a.uncachedInput += b.uncachedInput;
  a.cacheRead += b.cacheRead;
  a.cacheCreation5m += b.cacheCreation5m;
  a.cacheCreation1h += b.cacheCreation1h;
  a.output += b.output;
  a.thinking += b.thinking;
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation5m: a.cacheCreation5m + b.cacheCreation5m,
    cacheCreation1h: a.cacheCreation1h + b.cacheCreation1h,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
  };
}

/** Billable tokens. `thinking` is excluded — it already sits inside `output`. */
export function totalTokens(totals: TokenTotals): number {
  return (
    totals.uncachedInput +
    totals.cacheRead +
    totals.cacheCreation5m +
    totals.cacheCreation1h +
    totals.output
  );
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Canonical lookup name: lowercased, with any `provider/` prefix stripped.
 * LiteLLM publishes both `claude-opus-5` and `vertex_ai/claude-opus-5`.
 */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Projects a LiteLLM-shaped document into a rate table.
 *
 * Entries missing either an input or an output rate are dropped: a
 * half-priced model under-reports silently, which is worse than reporting the
 * model as unpriced.
 *
 * Prefixed keys must not clobber the canonical one. `deepinfra/anthropic/
 * claude-opus-5` normalizes to the same name as `claude-opus-5` but omits the
 * 1-hour cache rate, so a naive last-wins merge loses a rate that the
 * canonical entry publishes. Unprefixed keys therefore win, and among
 * prefixed keys the first seen wins.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  const root = asRecord(document);
  if (!root) return table;

  for (const [name, raw] of Object.entries(root)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const input = finite(entry.input_cost_per_token);
    const output = finite(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    // A model that omits a cache rate is priced as if the tokens were plain
    // input, never as if they were free. The 1-hour write is twice the input
    // rate on every Anthropic entry that publishes it, which is what makes
    // that specific derivation safe rather than a guess.
    const rate: ModelRate = {
      inputPerToken: input,
      outputPerToken: output,
      cacheReadPerToken: finite(entry.cache_read_input_token_cost) ?? input,
      cacheWrite5mPerToken: finite(entry.cache_creation_input_token_cost) ?? input,
      cacheWrite1hPerToken: finite(entry.cache_creation_input_token_cost_above_1hr) ?? input * 2,
    };

    const key = name.trim().toLowerCase();
    if (!key.includes("/")) {
      // The canonical entry always wins, whenever it is met.
      table.set(key, rate);
      continue;
    }
    // A prefixed entry claims both spellings only if nothing holds them yet,
    // so the first provider seen wins and none of them displaces the canonical.
    if (!table.has(key)) table.set(key, rate);
    const bare = normalizeModelName(key);
    if (!table.has(bare)) table.set(bare, rate);
  }
  return table;
}

/** The embedded Anthropic-only table, for hosts with no network. */
export function fallbackRateTable(): RateTable {
  return parseRateTable(FALLBACK_RATES);
}

/**
 * Models that are never priced.
 *
 * `<synthetic>` marks locally generated messages that never reached the API.
 * Bare family names are ambiguous across generations, so they are reported as
 * unpriced rather than resolved to a guessed generation.
 */
const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const key = model.trim().toLowerCase();
  if (key.length === 0 || UNPRICEABLE.has(key)) return null;
  return table.get(key) ?? table.get(normalizeModelName(key)) ?? null;
}

export type CostSource = "reported" | "priced" | "unpriced";

export interface PricedUsage {
  costUsd: number;
  source: CostSource;
}

/**
 * Prices one bucket of tokens. A cost the provider itself reported wins over
 * the table — it is the only figure that reflects what was actually charged.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: TokenTotals,
  reportedCostUsd: number | null
): PricedUsage {
  return priceWithRate(lookupRate(table, model), totals, reportedCostUsd);
}

/**
 * The same pricing against an already-resolved rate.
 *
 * Aggregation prices and measures cache savings for the same row, and looking
 * the model up twice per row costs two map probes and two string allocations
 * over tens of thousands of rows.
 */
export function priceWithRate(
  rate: ModelRate | null,
  totals: TokenTotals,
  reportedCostUsd: number | null
): PricedUsage {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, source: "reported" };
  }
  if (rate === null) return { costUsd: 0, source: "unpriced" };

  return {
    costUsd:
      totals.uncachedInput * rate.inputPerToken +
      totals.cacheRead * rate.cacheReadPerToken +
      totals.cacheCreation5m * rate.cacheWrite5mPerToken +
      totals.cacheCreation1h * rate.cacheWrite1hPerToken +
      totals.output * rate.outputPerToken,
    source: "priced",
  };
}

/**
 * What the cached input would have cost at the full input rate, minus what it
 * actually cost. Cache writes are a premium and count against the saving.
 */
export function cacheSavingsUsd(table: RateTable, model: string, totals: TokenTotals): number {
  return savingsWithRate(lookupRate(table, model), totals);
}

export function savingsWithRate(rate: ModelRate | null, totals: TokenTotals): number {
  if (rate === null) return 0;
  return (
    totals.cacheRead * (rate.inputPerToken - rate.cacheReadPerToken) +
    totals.cacheCreation5m * (rate.inputPerToken - rate.cacheWrite5mPerToken) +
    totals.cacheCreation1h * (rate.inputPerToken - rate.cacheWrite1hPerToken)
  );
}
