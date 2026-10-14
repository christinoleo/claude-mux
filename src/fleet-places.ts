/**
 * Where a machine's sessions and plain panes go in the drawer: under which
 * of its project roots (CLAUDE.md §10, "The project rail").
 *
 * A plain pane is a tmux pane that runs no Claude session: a shell, a dev
 * server, htop. Every machine reports its own with its sessions broadcast
 * (`PlainPane`), so the drawer can place another machine's beside its
 * sessions. Kept apart from the server code so the page can import it.
 */

import { z } from "zod/v4";
import { findDeepestProject } from "./fleet-projects.js";

/** One plain pane, as its machine reports it. */
export const PlainPaneSchema = z.object({
  /** Its tmux target, `session:window.pane`. */
  target: z.string(),
  /** The tmux session it belongs to. */
  session: z.string(),
  /** What runs in it now (`pane_current_command`). */
  command: z.string(),
  /** The folder it sits in; '' when tmux did not say. */
  cwd: z.string(),
  /** Its title, as the program in it set it; null when it set none. */
  title: z.string().nullable(),
});

export type PlainPane = z.infer<typeof PlainPaneSchema>;

/** The root under which a session or pane that has not said where it runs is placed. */
export const NO_FOLDER = "";

/**
 * Whether a directory is nobody's project. The server knows the home
 * directory and keeps such paths out of the list it sends; this is the
 * browser's guess for a folder under no root: a path two segments deep
 * (`/home/leo`, `/tmp`) or a mount point.
 */
function looksLikeRoot(cwd: string): boolean {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return true;
  return /^\/(?:mnt|media|Volumes)\/[^/]+$/.test(cwd);
}

function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

/**
 * The project roots of a machine: what its server remembers, plus every
 * folder a session or plain pane runs in that sits under none of them (an
 * older server, a session that started this tick, a shell in a folder that
 * is nobody's project), reduced so no root sits under another. A folder
 * that is nobody's project (`~`, `/tmp`) becomes a project of its own on
 * that machine, last, so it never takes in the folders below it. One that
 * has not said where it runs (an empty cwd) is placed under `NO_FOLDER`,
 * so nothing is left out.
 */
export function projectRoots(projects: readonly string[], cwds: readonly (string | null | undefined)[]): string[] {
  const roots = [...projects];
  const known = cwds.filter((cwd): cwd is string => !!cwd);
  const extra = known.filter((cwd) => !looksLikeRoot(cwd)).sort((a, b) => a.length - b.length);
  for (const cwd of extra) {
    if (roots.some((r) => under(cwd, r))) continue;
    roots.push(cwd);
  }
  for (const cwd of new Set(known.filter(looksLikeRoot))) {
    if (!roots.includes(cwd) && !roots.some((r) => under(cwd, r))) roots.push(cwd);
  }
  if (known.length < cwds.length) roots.push(NO_FOLDER);
  return roots;
}

/** The root a folder is placed under: the deepest that holds it, `NO_FOLDER` for none given. */
export function rootOf(cwd: string | null | undefined, roots: readonly string[]): string | null {
  if (!cwd) return roots.includes(NO_FOLDER) ? NO_FOLDER : null;
  return findDeepestProject(cwd, roots.filter(Boolean));
}

/**
 * A machine's plain panes put under its roots (`projectRoots()`). Its server
 * already left out every pane a Claude session runs in.
 */
export function panesByRoot(panes: readonly PlainPane[], roots: readonly string[]): Map<string, PlainPane[]> {
  const out = new Map<string, PlainPane[]>();
  for (const pane of panes) {
    const root = rootOf(pane.cwd, roots);
    if (root === null) continue;
    const list = out.get(root);
    if (list) list.push(pane);
    else out.set(root, [pane]);
  }
  return out;
}
