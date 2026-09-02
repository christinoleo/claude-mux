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
import { homedir } from "os";
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
 * Directories that are nobody's project: the home directory, the root, the
 * places everything else lives under. A session opened in one of them is a
 * session without a project — it must not become a group of its own, and it
 * must never become the parent every real project nests under, which is what
 * happens the first time someone runs an agent in `~` by accident.
 */
export function isForbiddenRoot(cwd: string, home: string = homedir()): boolean {
  const path = cwd.replace(/\/+$/, "") || "/";
  if (path === "/" || path === home) return true;
  if (["/tmp", "/home", "/Users", "/root", "/mnt", "/media", "/opt", "/var", "/srv"].includes(path)) return true;
  // One level under a mount root is still a disk, not a project: /mnt/tudao.
  if (/^\/(?:mnt|media|Volumes)\/[^/]+$/.test(path)) return true;
  return false;
}

/** Whether `child` sits somewhere under `parent`. */
function isUnder(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Remember these directories as projects. Returns whether anything new was
 * written, so a caller that runs every poll can tell a no-op from a change
 * worth telling clients about.
 *
 * Only roots are kept: a directory under a remembered project is that
 * project's subfolder, not a project — the sidebar shows its sessions inside
 * the parent's card with the relative path — and a directory that turns out
 * to be above a remembered one takes it over, so the file always holds the
 * shallowest cwd of each tree. A forbidden root is never remembered at all.
 */
export function saveProjects(cwds: Iterable<string>): boolean {
  const file = readFile();
  let changed = false;
  for (const raw of cwds) {
    const cwd = raw?.replace(/\/+$/, "");
    if (!cwd || isForbiddenRoot(cwd)) continue;
    if (file.projects.some((p) => p === cwd || isUnder(cwd, p))) continue;
    const kept = file.projects.filter((p) => !isUnder(p, cwd));
    if (kept.length !== file.projects.length) changed = true;
    file.projects = [...kept, cwd];
    changed = true;
  }
  if (changed) writeFile(file);
  return changed;
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
