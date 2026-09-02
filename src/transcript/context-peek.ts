/**
 * The context usage of a session, read cheaply enough to do for every
 * session on every poll.
 *
 * The transcript view already knows a session's context: its builder tails
 * the JSONL and keeps the last `usage`. The sidebar wants the same number
 * for every session at once, and tailing twenty files for it would be
 * twenty tailers. Instead: one `stat` per session per tick, and only when
 * the file has grown is its last 64 KB read and scanned backwards for the
 * most recent assistant line. A session that is idle costs a stat and
 * nothing else.
 */

import { closeSync, openSync, readSync, statSync } from "fs";
import { asRecord } from "./json.js";
import { contextPercent, readContextUsage, type ContextUsage } from "./context.js";
import { resolveTranscriptPath } from "./tailer.js";

/** Enough for a few dozen lines; an assistant line is rarely far from the end. */
const TAIL_BYTES = 64 * 1024;

/** How many polls to wait before looking again for a transcript that was not there. */
const RESOLVE_RETRY_POLLS = 20;

interface PathMemo {
  path: string | null;
  /** Polls since the path was last resolved (only counted while it is null). */
  age: number;
}

interface FileMemo {
  mtimeMs: number;
  size: number;
  usage: ContextUsage | null;
}

const paths = new Map<string, PathMemo>();
const files = new Map<string, FileMemo>();

/** Forget everything — for tests. */
export function resetContextPeekCache(): void {
  paths.clear();
  files.clear();
}

/**
 * Where a session's transcript is, remembered per session so the fallback
 * scan of the projects directory does not run every tick for a session
 * that has not written a file yet.
 */
function transcriptPathFor(session: { id: string; cwd: string; transcript_path?: string | null }): string | null {
  const memo = paths.get(session.id);
  if (memo && (memo.path !== null || memo.age < RESOLVE_RETRY_POLLS)) {
    if (memo.path === null) memo.age++;
    return memo.path;
  }
  const path = resolveTranscriptPath(session, session.id);
  paths.set(session.id, { path, age: 0 });
  return path;
}

/** Scan the tail of the file backwards for the last assistant line with usage. */
function readLastUsage(path: string, size: number): ContextUsage | null {
  const length = Math.min(size, TAIL_BYTES);
  if (length === 0) return null;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf-8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap reject before parsing: most lines are tool results and user turns.
    if (!line.includes('"assistant"')) continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record?.type !== "assistant") continue;
      const message = asRecord(record.message);
      const usage = message ? readContextUsage(message) : null;
      if (usage) return usage;
    } catch {
      // The first line of the window is usually cut mid-record; skip it.
    }
  }
  return null;
}

/**
 * The session's context usage as of its latest reply, or null when there is
 * no transcript yet or no reply in it.
 */
export function peekContextUsage(session: {
  id: string;
  cwd: string;
  transcript_path?: string | null;
}): ContextUsage | null {
  const path = transcriptPathFor(session);
  if (!path) return null;
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    files.delete(path);
    paths.delete(session.id);
    return null;
  }
  const memo = files.get(path);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.usage;
  // A tail with no assistant line in it (a burst of tool results) keeps the
  // last usage seen rather than blanking the gauge until the next reply.
  const usage = readLastUsage(path, stat.size) ?? memo?.usage ?? null;
  files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
  return usage;
}

/** The same, as the percentage the sidebar draws; null when unknown. */
export function peekContextPercent(session: {
  id: string;
  cwd: string;
  transcript_path?: string | null;
}): number | null {
  const usage = peekContextUsage(session);
  return usage ? contextPercent(usage) : null;
}
