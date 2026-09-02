/**
 * The projects the sidebar groups sessions under, kept on the server.
 *
 * A project is a directory a session has run in. The sidebar used to remember
 * them in the browser's localStorage, which meant every device kept its own
 * list, and "Reset data" — a button about that one browser's cache — took
 * every project without a live session with it. A directory belongs to the
 * machine it is on, so the machine remembers it: `~/.claude-mux/projects.json`
 * next to the sessions, shared by every browser that connects, and untouched
 * by anything the browser clears.
 *
 * The file is written atomically (tmp + rename), like a session file, so a
 * poll reading it mid-write sees the old list rather than half of the new.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getSessionsDir } from "./sessions-json.js";

/** Overridable for tests; null means "next to the sessions directory". */
let projectsPath: string | null = null;

export function setProjectsPath(path: string | null): void {
  projectsPath = path;
}

function resolveProjectsPath(): string {
  return projectsPath ?? join(dirname(getSessionsDir()), "projects.json");
}

interface ProjectsFile {
  v: 1;
  /** Absolute directories, in the order they were first seen. */
  projects: string[];
}

function readFile(): ProjectsFile {
  const path = resolveProjectsPath();
  if (!existsSync(path)) return { v: 1, projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProjectsFile>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    return { v: 1, projects: [...new Set(projects)] };
  } catch {
    // A torn or hand-edited file must not take the sidebar down with it.
    return { v: 1, projects: [] };
  }
}

function writeFile(file: ProjectsFile): void {
  const path = resolveProjectsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

/** Every remembered project, oldest first. */
export function getSavedProjects(): string[] {
  return readFile().projects;
}

/**
 * Remember these directories. Returns whether anything new was written, so a
 * caller that runs every poll can tell a no-op from a change worth telling
 * clients about.
 */
export function saveProjects(cwds: Iterable<string>): boolean {
  const file = readFile();
  const known = new Set(file.projects);
  let added = false;
  for (const cwd of cwds) {
    if (!cwd || known.has(cwd)) continue;
    known.add(cwd);
    file.projects.push(cwd);
    added = true;
  }
  if (added) writeFile(file);
  return added;
}

export function saveProject(cwd: string): boolean {
  return saveProjects([cwd]);
}

/** Forget a directory. Returns whether it was there. */
export function removeProject(cwd: string): boolean {
  const file = readFile();
  const next = file.projects.filter((p) => p !== cwd);
  if (next.length === file.projects.length) return false;
  writeFile({ ...file, projects: next });
  return true;
}
