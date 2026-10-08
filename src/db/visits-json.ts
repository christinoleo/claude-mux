/**
 * When someone last looked at each session, kept in `~/.claude-mux/visits.json`.
 *
 * A turn that ends while nobody is watching is unread "Done" until somebody
 * opens the session, on any browser: the watermark lives on the server for
 * exactly that reason, so a phone that read it clears the desktop's badge.
 * The hook never touches this file — it stamps `turn_completed_at` on the
 * session, and the server compares the two.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { getSessionsDir } from "./sessions-json.js";
import { writeFileAtomic } from "../utils/atomic-write.js";

/** Session id → last visit (epoch ms). */
export type Visits = Record<string, number>;

/** An entry this old whose session file is gone is dropped on the next write. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

let visitsPath: string | null = null;
let cache: { mtimeMs: number; visits: Visits } | null = null;

/** Overridable for tests; null means "next to the sessions directory". */
export function setVisitsPath(path: string | null): void {
  visitsPath = path;
  cache = null;
}

function resolveVisitsPath(): string {
  return visitsPath ?? join(dirname(getSessionsDir()), "visits.json");
}

/** Every recorded visit. Read on each session poll, so parsed only when the file changed. */
export function getVisits(): Visits {
  const path = resolveVisitsPath();
  try {
    const { mtimeMs } = statSync(path);
    if (cache?.mtimeMs === mtimeMs) return cache.visits;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const visits: Visits = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, at] of Object.entries(parsed)) {
        if (typeof at === "number" && Number.isFinite(at)) visits[id] = at;
      }
    }
    cache = { mtimeMs, visits };
    return visits;
  } catch {
    // Missing is empty. Unreadable (a hand edit, a cut-off write) keeps the
    // last good copy, so the next visit does not write every other
    // session's watermark away.
    return cache?.visits ?? {};
  }
}

/** Someone is looking at the session now. */
export function recordVisit(id: string, at: number = Date.now()): void {
  const now = Date.now();
  const next: Visits = {};
  for (const [other, when] of Object.entries(getVisits())) {
    // A session can live for months without being opened; only a gone one goes.
    if (now - when < KEEP_MS || existsSync(join(getSessionsDir(), `${other}.json`))) next[other] = when;
  }
  next[id] = at;
  const path = resolveVisitsPath();
  writeFileAtomic(path, JSON.stringify(next, null, 2));
  // Keep what was just written, so the next poll need not parse it back.
  cache = { mtimeMs: statSync(path).mtimeMs, visits: next };
}

/**
 * Put the session's last turn back to unread: the watermark rewinds to just
 * before the turn ended. A session with no finished turn has nothing to mark.
 */
export function markUnread(id: string, turnCompletedAt: number | null | undefined): boolean {
  if (!turnCompletedAt) return false;
  recordVisit(id, turnCompletedAt - 1);
  return true;
}
