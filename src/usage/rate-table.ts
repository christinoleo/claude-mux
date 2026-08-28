/**
 * Fetching and caching of the LiteLLM price document.
 *
 * The published table is the moving part of cost reporting: a model released
 * after the last claude-mux release still has to price correctly. It is
 * refreshed daily, cached on disk, and falls back to the embedded Anthropic
 * snapshot when the network is unavailable.
 */

import { readFileSync, statSync } from "fs";
import { join } from "path";

import { asRecord } from "../transcript/json.js";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { fallbackRateTable, parseRateTable, type RateTable } from "./pricing.js";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const PRICES_CACHE_PATH = join(CLAUDE_MUX_DIR, "litellm-prices.json");

const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export type RateSource = "live" | "cache" | "fallback";

export interface RateTableResult {
  table: RateTable;
  source: RateSource;
  /** When the cached document was written, or null when none was used. */
  fetchedAtMs: number | null;
}

/**
 * Keeps only the unprefixed Anthropic entries.
 *
 * claude-mux prices Claude Code and nothing else, and Claude Code writes bare
 * model ids. Storing the whole 2 MB document would cost a re-parse on every
 * cold start to hold 3,300 models that can never be looked up. Widen this the
 * day another agent is supported.
 */
function anthropicSubset(document: unknown): Record<string, unknown> {
  const root = asRecord(document);
  if (!root) return {};
  const subset: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(root)) {
    if (name.includes("/") || !name.startsWith("claude-")) continue;
    subset[name] = entry;
  }
  return subset;
}

function readCache(): { document: unknown; fetchedAtMs: number } | null {
  try {
    const raw = readFileSync(PRICES_CACHE_PATH, "utf-8");
    const fetchedAtMs = statSync(PRICES_CACHE_PATH).mtimeMs;
    return { document: JSON.parse(raw), fetchedAtMs };
  } catch {
    return null;
  }
}

function writeCache(document: Record<string, unknown>): void {
  try {
    writeFileAtomic(PRICES_CACHE_PATH, JSON.stringify(document));
  } catch {
    // A cache that cannot be written costs one fetch per call, nothing more.
  }
}

let memo: RateTableResult | null = null;
let memoAtMs = 0;

/**
 * Resolves the rate table, preferring a fresh disk cache, then the network,
 * then a stale cache, then the embedded snapshot.
 */
export async function loadRateTable(force = false): Promise<RateTableResult> {
  const now = Date.now();
  if (!force && memo && now - memoAtMs < TTL_MS) return memo;

  const cached = readCache();
  if (!force && cached && now - cached.fetchedAtMs < TTL_MS) {
    memo = {
      table: parseRateTable(cached.document),
      source: "cache",
      fetchedAtMs: cached.fetchedAtMs,
    };
    memoAtMs = now;
    return memo;
  }

  try {
    const response = await fetch(LITELLM_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const subset = anthropicSubset(await response.json());
    if (Object.keys(subset).length === 0) throw new Error("no Anthropic entries");
    writeCache(subset);
    memo = { table: parseRateTable(subset), source: "live", fetchedAtMs: now };
    memoAtMs = now;
    return memo;
  } catch {
    // A stale cache is still far better than the embedded snapshot.
    if (cached) {
      memo = {
        table: parseRateTable(cached.document),
        source: "cache",
        fetchedAtMs: cached.fetchedAtMs,
      };
      memoAtMs = now;
      return memo;
    }
    memo = { table: fallbackRateTable(), source: "fallback", fetchedAtMs: null };
    memoAtMs = now;
    return memo;
  }
}

/** Drops the in-process memo. Exists for tests. */
export function resetRateTableMemo(): void {
  memo = null;
  memoAtMs = 0;
}
