/**
 * A past session as machines publish it to each other and to the page: a
 * conversation whose transcript is on a machine's disk with no live pane
 * (GLOSSARY.md). Read off the transcripts by `src/transcript/past-sessions.ts`;
 * kept apart from it so the browser can import the shape without `node:fs`.
 */

import { z } from "zod/v4";
import { findDeepestProject } from "./fleet-projects.js";

/** One past session, as a machine publishes it with its fleet state. */
export const PastSessionSchema = z.object({
  /** Claude Code's session id, the transcript's file name. */
  id: z.string(),
  /** The folder it last ran in; null when the transcript never said. */
  cwd: z.string().nullable(),
  branch: z.string().nullable(),
  /** Its title (/rename's, else Claude Code's own); null when it has none near the ends of the file. */
  title: z.string().nullable(),
  /** Its first prompt, cut short. */
  prompt: z.string().nullable(),
  /** When it was last written to (ms). */
  lastActivity: z.number(),
});

export type PastSession = z.infer<typeof PastSessionSchema>;

/** How many of a project's past sessions Settled shows before "more". */
export const SETTLED_SHOWN = 10;

/** What a past session is called in a list: its title, else its first prompt. */
export function pastLabel(past: Pick<PastSession, "id" | "title" | "prompt">): string {
  return past.title ?? past.prompt ?? `Session ${past.id.slice(0, 8)}`;
}

/**
 * A machine's past sessions put under its project roots, by the deepest root
 * that holds the folder each ran in. One the machine also lists as a session
 * is live and left out, as is one under none of the roots.
 */
export function pastByRoot(
  past: readonly PastSession[],
  roots: readonly string[],
  live: ReadonlySet<string>
): Map<string, PastSession[]> {
  const out = new Map<string, PastSession[]>();
  const named = roots.filter(Boolean);
  for (const p of past) {
    if (live.has(p.id) || !p.cwd) continue;
    const best = findDeepestProject(p.cwd, named);
    if (best === null) continue;
    const list = out.get(best);
    if (list) list.push(p);
    else out.set(best, [p]);
  }
  return out;
}
