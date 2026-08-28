/**
 * Durable per-file cache of parsed usage records.
 *
 * Transcripts are append-only, so a file whose size and mtime are unchanged
 * can never yield different usage, and a file that only grew needs nothing but
 * its new bytes parsed. Each entry therefore carries the byte offset already
 * consumed alongside the records read so far.
 *
 * Records are cached rather than day buckets. Bucketing depends on the
 * reporting time zone, and zones exist at :30 and :45 offsets, so no
 * coarse-grained bucket can be re-cut into another zone's days without error.
 * Caching records keeps the cache zone-independent at a size this history does
 * not notice: a few thousand rows after de-duplication.
 *
 * The serialised form is positional and interns the repeated strings, which is
 * the difference between a file measured in megabytes and one measured in
 * hundreds of kilobytes.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { asRecord } from "../transcript/json.js";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import type { UsageRecord } from "./transcripts.js";

/**
 * Bumped whenever a parser change alters what a given file parses to. A stale
 * entry written by an older parser would otherwise be served forever.
 */
export const USAGE_CACHE_VERSION = 1;

export const USAGE_CACHE_PATH = join(CLAUDE_MUX_DIR, "usage-cache.json");

export interface CachedFile {
  size: number;
  mtimeMs: number;
  /** Bytes already parsed. Equals `size` unless the file grew mid-session. */
  offset: number;
  /** De-duplicated within this file, in the order first seen. */
  records: UsageRecord[];
}

export type UsageCache = Map<string, CachedFile>;

type SerializedRecord = [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  cwdIndex: number,
  uncachedInput: number,
  cacheRead: number,
  cacheCreation5m: number,
  cacheCreation1h: number,
  output: number,
  thinking: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
];

interface SerializedFile {
  s: number;
  m: number;
  o: number;
  r: SerializedRecord[];
}

interface SerializedCache {
  version: number;
  models: string[];
  sessions: string[];
  cwds: string[];
  files: Record<string, SerializedFile>;
}

class Interner {
  private readonly index = new Map<string, number>();
  readonly values: string[] = [];

  intern(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.values.length;
    this.index.set(value, next);
    this.values.push(value);
    return next;
  }
}

export function serializeCache(cache: UsageCache): string {
  const models = new Interner();
  const sessions = new Interner();
  const cwds = new Interner();
  const files: Record<string, SerializedFile> = {};

  for (const [path, entry] of cache) {
    files[path] = {
      s: entry.size,
      m: entry.mtimeMs,
      o: entry.offset,
      r: entry.records.map((record) => [
        record.timestampMs,
        models.intern(record.model),
        sessions.intern(record.sessionId),
        cwds.intern(record.cwd),
        record.totals.uncachedInput,
        record.totals.cacheRead,
        record.totals.cacheCreation5m,
        record.totals.cacheCreation1h,
        record.totals.output,
        record.totals.thinking,
        record.dedupeKey,
        record.reportedCostUsd,
      ]),
    };
  }

  const payload: SerializedCache = {
    version: USAGE_CACHE_VERSION,
    models: models.values,
    sessions: sessions.values,
    cwds: cwds.values,
    files,
  };
  return JSON.stringify(payload);
}

function stringAt(table: string[], index: unknown): string {
  return typeof index === "number" && index >= 0 && index < table.length ? table[index] : "";
}

/** Returns an empty cache for anything unreadable, stale, or malformed. */
export function deserializeCache(raw: string): UsageCache {
  const cache: UsageCache = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cache;
  }
  const root = asRecord(parsed);
  if (!root || root.version !== USAGE_CACHE_VERSION) return cache;

  const models = Array.isArray(root.models) ? (root.models as string[]) : [];
  const sessions = Array.isArray(root.sessions) ? (root.sessions as string[]) : [];
  const cwds = Array.isArray(root.cwds) ? (root.cwds as string[]) : [];
  const files = asRecord(root.files);
  if (!files) return cache;

  for (const [path, rawEntry] of Object.entries(files)) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const { s, m, o, r } = entry;
    if (typeof s !== "number" || typeof m !== "number" || typeof o !== "number") continue;
    if (!Array.isArray(r)) continue;

    const records: UsageRecord[] = [];
    for (const row of r as SerializedRecord[]) {
      if (!Array.isArray(row) || row.length < 12) continue;
      records.push({
        timestampMs: row[0],
        model: stringAt(models, row[1]),
        sessionId: stringAt(sessions, row[2]),
        cwd: stringAt(cwds, row[3]),
        totals: {
          uncachedInput: row[4],
          cacheRead: row[5],
          cacheCreation5m: row[6],
          cacheCreation1h: row[7],
          output: row[8],
          thinking: row[9],
        },
        dedupeKey: row[10],
        reportedCostUsd: row[11],
      });
    }
    cache.set(path, { size: s, mtimeMs: m, offset: o, records });
  }
  return cache;
}

export function loadCache(path: string = USAGE_CACHE_PATH): UsageCache {
  try {
    return deserializeCache(readFileSync(path, "utf-8"));
  } catch {
    return new Map();
  }
}

export function saveCache(cache: UsageCache, path: string = USAGE_CACHE_PATH): void {
  try {
    writeFileAtomic(path, serializeCache(cache));
  } catch {
    // A cache that cannot be written costs a cold scan next time, nothing more.
  }
}
