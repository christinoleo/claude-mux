/**
 * What the New folder picker says about a folder (`FolderPicker.svelte`):
 * whether it is already open on the machine being browsed, open on another,
 * or holds open folders further down.
 *
 * An open folder is a project root on some machine (`projectRoots()`), with
 * the live sessions that run there; one with none is a project on the rail
 * and nothing more. A folder that is no root on the machine being browsed is
 * matched to a project the way `mergeProjects()` matches a root it has no
 * report for (`guessReport()`): by its path under `~/Projects`, joining the
 * one project that has a root there or is named so.
 */

import { NO_FOLDER } from "./fleet-places.js";
import { guessReport } from "./fleet-projects.js";

/** A project root on one machine. */
export interface OpenFolder {
  machineId: string;
  root: string;
  /** Its project's key (`projectKey()`), the same on every machine that holds it. */
  project: string;
  /** Its project's name (`projectName()`). */
  name: string;
  /** Live sessions running there; 0 for a project on the rail with none. */
  live: number;
  /** Whether one of them wants a person. */
  wants: boolean;
}

export interface FolderMarks<T extends OpenFolder> {
  /** The folder itself, open on the machine being browsed. */
  here: T | null;
  /** The same project open on other machines, those with live sessions first. */
  elsewhere: T[];
  /** How many folders open on the machine being browsed sit below it. */
  below: number;
}

/**
 * Marks for every folder the picker draws on one machine. Built once per
 * machine and list of open folders, then asked once per row.
 */
export function folderMarker<T extends OpenFolder>(machineId: string, open: readonly T[]): (path: string) => FolderMarks<T> {
  const folders = open.filter((f) => f.root !== NO_FOLDER);
  const mine = folders.filter((f) => f.machineId === machineId);
  const byRoot = new Map(mine.map((f) => [f.root, f]));

  // Each project's folders on the other machines, those with live sessions first.
  const others = new Map<string, T[]>();
  for (const f of folders) {
    if (f.machineId !== machineId) others.set(f.project, [...(others.get(f.project) ?? []), f]);
  }
  for (const list of others.values()) list.sort((a, b) => Number(b.live > 0) - Number(a.live > 0));

  // A folder under `~/Projects` that is no root here goes by the project
  // whose root elsewhere sits at the same place, or whose name it is; a place
  // or name two projects answer to says nothing, and a place outranks a name.
  const unique = (pairs: [string, string][]) => {
    const out = new Map<string, string | null>();
    for (const [k, project] of pairs) {
      const had = out.get(k);
      out.set(k, had === undefined || had === project ? project : null);
    }
    return out;
  };
  const byPlace = unique(folders.flatMap((f): [string, string][] => {
    const home = guessReport(f.root).home;
    return home ? [[home, f.project]] : [];
  }));
  const byName = unique(folders.map((f) => [f.name, f.project]));

  return (path) => {
    const here = byRoot.get(path) ?? null;
    const home = guessReport(path).home;
    const project = here?.project ?? (home ? (byPlace.has(home) ? byPlace.get(home) : byName.get(home)) : null) ?? null;
    const elsewhere = (project && others.get(project)) || [];
    const prefix = path === "/" ? "/" : `${path}/`;
    const below = mine.filter((f) => f.root.startsWith(prefix)).length;
    return { here, elsewhere, below };
  };
}

/**
 * The folders open on one machine, for the list atop the picker: those
 * wanting a person first, then those with live sessions, then the rest, each
 * group by path.
 */
export function openOn<T extends OpenFolder>(machineId: string, open: readonly T[]): T[] {
  const rank = (f: OpenFolder) => (f.wants ? 0 : f.live > 0 ? 1 : 2);
  return open
    .filter((f) => f.machineId === machineId && f.root !== NO_FOLDER)
    .sort((a, b) => rank(a) - rank(b) || a.root.localeCompare(b.root));
}

/**
 * Where to open on another machine's tab: the same place relative to home
 * (`~/Projects/x` here is `~/Projects/x` there), or the path as it stands
 * when it is outside home. The picker falls back to `~` when the other
 * machine has no such folder.
 */
export function carryPath(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
