/**
 * Walks the Claude Code transcript tree and produces de-duplicated usage
 * records, reusing the on-disk cache for everything that has not changed.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import type { Dirent } from "fs";
import { join, relative, sep } from "path";

import { CLAUDE_DIR } from "../utils/paths.js";
import type { UsageCache } from "./scan-cache.js";
import { parseUsageLine, type UsageRecord } from "./transcripts.js";

export const PROJECTS_ROOT = join(CLAUDE_DIR, "projects");

const NEWLINE = 0x0a;
/** `"usage"` — the byte-level form of the gate `parseUsageLine` needs. */
const USAGE_NEEDLE = Buffer.from('"usage"');

/** A parsed record tagged with the project directory its transcript sits in. */
export interface ScannedRecord extends UsageRecord {
  /** Escaped project directory, e.g. `-home-me-Projects-claude-mux`. */
  project: string;
}

export interface ScanResult {
  /** De-duplicated across the whole tree, ordered by the walk. */
  records: ScannedRecord[];
  /** Escaped project directory -> the real cwd last seen for it. */
  projectLabels: Map<string, string>;
  filesParsed: number;
  filesReused: number;
  /**
   * Records dropped because their key was already seen in a *different* file.
   *
   * Measured at zero across a full local history, which is what lets the
   * per-file cache de-duplicate on its own. A non-zero count here means that
   * assumption has broken and the cache is now over-counting.
   */
  crossFileDuplicates: number;
}

interface ReadFromResult {
  lines: string[];
  /** Byte offset of the end of the last complete line. */
  nextOffset: number;
  size: number;
  mtimeMs: number;
  shrank: boolean;
}

/**
 * Reads whole lines from `offset` onward.
 *
 * `JsonlTailer` does the same byte-level splitting, but it keeps a partial
 * trailing line in memory and advances its offset past it. That is right for a
 * live stream and wrong for a durable cache, which must resume from a newline
 * boundary after a restart. This returns an offset that is always aligned to
 * the last newline, so a half-written line is simply re-read next time.
 */
function readLinesFrom(path: string, offset: number): ReadFromResult | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size < offset) {
      return { lines: [], nextOffset: 0, size, mtimeMs: stat.mtimeMs, shrank: true };
    }
    if (size === offset) {
      return { lines: [], nextOffset: offset, size, mtimeMs: stat.mtimeMs, shrank: false };
    }

    // `allocUnsafe` skips a zero-fill of the whole remainder; every byte handed
    // on is one that `readSync` wrote, tracked by `read`.
    const chunk = Buffer.allocUnsafe(size - offset);
    let read = 0;
    while (read < chunk.length) {
      const n = readSync(fd, chunk, read, chunk.length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }

    /*
     * Split on newlines and gate on bytes, both before decoding anything.
     * Transcripts are mostly tool output: roughly two thirds of lines carry no
     * usage at all, and decoding them to UTF-8 strings only to discard them was
     * the bulk of a cold scan. `indexOf` also hands the newline search to the
     * native scanner instead of walking 200 MB a byte at a time in JS.
     */
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline === -1 || newline >= read) break;
      const needle = chunk.indexOf(USAGE_NEEDLE, start);
      if (needle !== -1 && needle < newline) {
        lines.push(chunk.toString("utf8", start, newline));
      }
      start = newline + 1;
    }
    return { lines, nextOffset: offset + start, size, mtimeMs: stat.mtimeMs, shrank: false };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Every `.jsonl` under `root`, including subagent transcripts. */
function listTranscripts(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".jsonl")) found.push(child);
    }
  };
  walk(root);
  return found;
}

/**
 * The escaped project directory a transcript belongs to. Subagent transcripts
 * live several levels down; the first path segment is still the project.
 */
export function projectKeyFor(path: string, root: string = PROJECTS_ROOT): string {
  const rel = relative(root, path);
  const first = rel.split(sep)[0];
  return first && first !== ".." ? first : "";
}

/**
 * The directory name Claude Code derives from a launch cwd. Lossy — a slash and
 * a hyphen both become a hyphen — but exact in this direction, which is what
 * makes it usable as a match test.
 */
function escapeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Picks the cwd that names a project directory.
 *
 * A session records its *current* cwd on every line, and that changes when the
 * user moves around inside the session. Taking the last one seen mislabels a
 * whole project after a single excursion — a `$HOME` project whose last line
 * happened to sit in a repo took on that repo's name. The cwd whose escaped
 * form is the directory itself is the launch cwd, so it wins outright; failing
 * that, the most frequently recorded one is the best available guess.
 */
function resolveProjectLabel(project: string, counts: Map<string, number>): string | null {
  let modal: string | null = null;
  let best = 0;
  for (const [cwd, count] of counts) {
    if (escapeCwd(cwd) === project) return cwd;
    if (count > best) {
      best = count;
      modal = cwd;
    }
  }
  return modal;
}

function parseLines(lines: string[], seen: Set<string>, into: UsageRecord[]): void {
  for (const line of lines) {
    const record = parseUsageLine(line);
    if (record === null) continue;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    into.push(record);
  }
}

export interface ScanOptions {
  root?: string;
  /**
   * Skip files last modified before this instant. A transcript's records are
   * never newer than its mtime, so nothing in the window is missed.
   */
  sinceMs?: number;
}

/**
 * Scans the tree, mutating `cache` in place so the caller can persist it.
 */
export function scanUsage(cache: UsageCache, options: ScanOptions = {}): ScanResult {
  const root = options.root ?? PROJECTS_ROOT;
  const sinceMs = options.sinceMs ?? null;

  const records: ScannedRecord[] = [];
  const cwdCounts = new Map<string, Map<string, number>>();
  const globalKeys = new Set<string>();
  let filesParsed = 0;
  let filesReused = 0;
  let crossFileDuplicates = 0;

  const paths = listTranscripts(root);
  const live = new Set(paths);
  for (const path of cache.keys()) {
    if (!live.has(path)) cache.delete(path);
  }

  for (const path of paths) {
    let mtimeMs: number;
    let size: number;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      continue;
    }
    if (sinceMs !== null && mtimeMs < sinceMs) continue;

    const cached = cache.get(path);
    let entry = cached;

    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      filesReused++;
    } else {
      // A file that only grew resumes from the cached offset; a file seen for
      // the first time is read from the start. The `shrank` re-read covers only
      // a truncation racing between the stat above and the open below, since
      // `resumable` already compares the stat's size against the cached offset.
      const resumable = cached !== undefined && size >= cached.offset;
      let result = readLinesFrom(path, resumable ? cached.offset : 0);
      if (result === null) continue;

      let base = resumable && !result.shrank ? cached.records.slice() : [];
      if (result.shrank) {
        result = readLinesFrom(path, 0);
        if (result === null) continue;
        base = [];
      }

      const seen = new Set<string>();
      for (const record of base) {
        if (record.dedupeKey !== null) seen.add(record.dedupeKey);
      }
      parseLines(result.lines, seen, base);

      entry = {
        size: result.size,
        mtimeMs: result.mtimeMs,
        offset: result.nextOffset,
        records: base,
      };
      cache.set(path, entry);
      filesParsed++;
    }

    if (!entry) continue;
    const project = projectKeyFor(path, root);
    for (const record of entry.records) {
      if (record.dedupeKey !== null) {
        if (globalKeys.has(record.dedupeKey)) {
          crossFileDuplicates++;
          continue;
        }
        globalKeys.add(record.dedupeKey);
      }
      if (project && record.cwd) {
        let counts = cwdCounts.get(project);
        if (!counts) {
          counts = new Map();
          cwdCounts.set(project, counts);
        }
        counts.set(record.cwd, (counts.get(record.cwd) ?? 0) + 1);
      }
      records.push({ ...record, project });
    }
  }

  const projectLabels = new Map<string, string>();
  for (const [project, counts] of cwdCounts) {
    const label = resolveProjectLabel(project, counts);
    if (label !== null) projectLabels.set(project, label);
  }

  return { records, projectLabels, filesParsed, filesReused, crossFileDuplicates };
}
