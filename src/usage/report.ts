/**
 * Ties the scanner, the rate table and the aggregator into the report the API
 * serves. Holds the parsed-file cache for the life of the process so a page
 * refresh re-reads only what actually changed on disk.
 */

import { getAllSessions } from "../db/sessions-json.js";
import { aggregateUsage, unpricedModels, type UsageReport } from "./aggregate.js";
import { hostTimeZone } from "./day.js";
import { loadRateTable, type RateSource } from "./rate-table.js";
import { loadCache, saveCache, type UsageCache } from "./scan-cache.js";
import { scanUsage } from "./scan.js";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the window both usage routes accept: `days` back from now, and the
 * IANA zone the days are cut in. The oldest day of a rolling window is partial
 * by construction.
 */
export function parseUsageQuery(params: URLSearchParams): UsageQuery & { days: number } {
  const raw = Number(params.get("days"));
  const days =
    Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), MAX_DAYS) : DEFAULT_DAYS;
  return {
    days,
    fromMs: Date.now() - days * DAY_MS,
    timeZone: params.get("tz") ?? undefined,
  };
}

export interface UsageQuery {
  fromMs?: number;
  toMs?: number;
  /** IANA zone the days are cut in. Defaults to the host's zone. */
  timeZone?: string;
}

export interface UsageResponse extends UsageReport {
  generatedAtMs: number;
  rates: {
    source: RateSource;
    fetchedAtMs: number | null;
  };
  scan: {
    filesParsed: number;
    filesReused: number;
    /**
     * Non-zero means a transcript repeats another file's records, which the
     * per-file cache is not built to survive. Surfaced so it cannot rot
     * silently into an inflated bill.
     */
    crossFileDuplicates: number;
  };
  /** Models seen in the window that no rate table could price. */
  unpricedModels: string[];
}

let cache: UsageCache | null = null;

/**
 * Serialising the whole cache costs milliseconds and a megabyte of writing, and
 * a live session leaves a file dirty on essentially every request. Writing at
 * most this often keeps that off the response path without risking much: a lost
 * write only costs the next cold start a re-parse.
 */
const CACHE_WRITE_INTERVAL_MS = 10_000;
let cacheWrittenAtMs = 0;

/**
 * The page and the sidebar widget both ask on load. Without this they run two
 * full scans concurrently and each writes the cache.
 */
let inFlight: Promise<UsageResponse> | null = null;

/**
 * Git roots keyed by the session ids claude-mux knows about.
 *
 * Sessions the hook never saw — anything predating claude-mux, or run outside
 * it — simply have no entry, which is why the project label falls back to the
 * cwd read out of the transcript itself.
 */
function gitRootsBySession(): Map<string, string> {
  const roots = new Map<string, string>();
  try {
    for (const session of getAllSessions()) {
      if (session.git_root) roots.set(session.id, session.git_root);
    }
  } catch {
    // The report is still correct without the enrichment.
  }
  return roots;
}

export async function buildUsageReport(query: UsageQuery = {}): Promise<UsageResponse> {
  if (inFlight !== null) return inFlight;
  inFlight = runUsageReport(query).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runUsageReport(query: UsageQuery): Promise<UsageResponse> {
  if (cache === null) cache = loadCache();

  // A file whose mtime precedes the window cannot hold a record inside it.
  const scan = scanUsage(cache, { sinceMs: query.fromMs });
  const now = Date.now();
  if (scan.filesParsed > 0 && now - cacheWrittenAtMs > CACHE_WRITE_INTERVAL_MS) {
    cacheWrittenAtMs = now;
    saveCache(cache);
  }

  const rates = await loadRateTable();

  // Worktrees and subdirectories of one repo each get their own escaped
  // directory. Where claude-mux knows the session, its git root collapses them
  // into a single row — relabelling alone would leave two rows wearing the same
  // name, which reads as a bug rather than as grouping.
  const roots = gitRootsBySession();
  const canonical = new Map<string, string>();
  for (const record of scan.records) {
    const root = roots.get(record.sessionId);
    if (root) canonical.set(record.project, root);
  }

  // A canonicalized project is keyed by its git root, which is already the
  // label; `aggregateUsage` falls back to the key, so only the rest need one.
  const labels = new Map<string, string>();
  for (const [project, cwd] of scan.projectLabels) {
    if (!canonical.has(project)) labels.set(project, cwd);
  }

  const attributed = canonical.size
    ? scan.records.map((record) => ({
        ...record,
        project: canonical.get(record.project) ?? record.project,
      }))
    : scan.records;

  const report = aggregateUsage(attributed, rates.table, {
    timeZone: query.timeZone ?? hostTimeZone(),
    projectLabels: labels,
    fromMs: query.fromMs,
    toMs: query.toMs,
  });

  return {
    ...report,
    generatedAtMs: Date.now(),
    rates: { source: rates.source, fetchedAtMs: rates.fetchedAtMs },
    scan: {
      filesParsed: scan.filesParsed,
      filesReused: scan.filesReused,
      crossFileDuplicates: scan.crossFileDuplicates,
    },
    unpricedModels: unpricedModels(report),
  };
}

/** Drops the in-process file cache. Exists for tests. */
export function resetUsageCache(): void {
  cache = null;
  cacheWrittenAtMs = 0;
  inFlight = null;
}
