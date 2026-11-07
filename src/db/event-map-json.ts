/**
 * The state map: which of this machine's projects claude-mux may act on when
 * GitHub changes, and what it does for each event (#183).
 *
 * Kept in `~/.claude-mux/event-map.json`, next to the sessions, because it
 * belongs to the machine that holds the projects. A project that is not in
 * the file is off; nothing is read for it and nothing fires. Enabling one
 * gives each event the rule, which today only records that the event was
 * seen; starting a session is never the default.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { getSessionsDir } from "./sessions-json.js";

/** The events polling finds: an issue Leo marked ready, and a push to the default branch. */
export const EVENT_KINDS = ["issue-ready", "push"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** What a project does with an event: nothing, its rule, or a session. */
export const EVENT_ACTIONS = ["ignore", "rule", "session"] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

export interface ProjectEventMap {
  enabled: boolean;
  /** Where the project's checkout is on this machine, as it was when enabled. */
  root: string;
  events: Record<EventKind, EventAction>;
}

export interface EventMap {
  v: 1;
  /** By `owner/name`. */
  projects: Record<string, ProjectEventMap>;
}

export const DEFAULT_EVENTS: Record<EventKind, EventAction> = { "issue-ready": "rule", push: "rule" };

let mapPath: string | null = null;

/** Overridable for tests; null means "next to the sessions directory". */
export function setEventMapPath(path: string | null): void {
  mapPath = path;
}

function resolvePath(): string {
  return mapPath ?? join(dirname(getSessionsDir()), "event-map.json");
}

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

export function isEventAction(value: unknown): value is EventAction {
  return typeof value === "string" && (EVENT_ACTIONS as readonly string[]).includes(value);
}

/** `owner/name`, the only spelling of a project the map keeps. */
export function isRepoSlug(value: unknown): value is string {
  return typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value);
}

function parseProject(raw: unknown): ProjectEventMap | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.root !== "string") return null;
  const events = { ...DEFAULT_EVENTS };
  const given = r.events && typeof r.events === "object" ? (r.events as Record<string, unknown>) : {};
  for (const kind of EVENT_KINDS) if (isEventAction(given[kind])) events[kind] = given[kind];
  return { enabled: r.enabled === true, root: r.root, events };
}

export function getEventMap(): EventMap {
  const path = resolvePath();
  if (!existsSync(path)) return { v: 1, projects: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { projects?: unknown };
    const projects: Record<string, ProjectEventMap> = {};
    if (raw.projects && typeof raw.projects === "object") {
      for (const [slug, value] of Object.entries(raw.projects as Record<string, unknown>)) {
        const project = parseProject(value);
        if (isRepoSlug(slug) && project) projects[slug] = project;
      }
    }
    return { v: 1, projects };
  } catch {
    // A torn or hand-edited file turns everything off rather than taking the server down.
    return { v: 1, projects: {} };
  }
}

/** The projects that are on, by `owner/name`. */
export function enabledProjects(map: EventMap = getEventMap()): Map<string, ProjectEventMap> {
  return new Map(Object.entries(map.projects).filter(([, p]) => p.enabled));
}

export interface ProjectPatch {
  enabled?: boolean;
  root?: string;
  events?: Partial<Record<EventKind, EventAction>>;
}

/** Change one project; returns the map as it now stands. */
export function updateProjectEvents(slug: string, patch: ProjectPatch): EventMap {
  const map = getEventMap();
  const have = map.projects[slug] ?? { enabled: false, root: patch.root ?? "", events: { ...DEFAULT_EVENTS } };
  map.projects[slug] = {
    enabled: patch.enabled ?? have.enabled,
    root: patch.root ?? have.root,
    events: { ...have.events, ...patch.events },
  };
  writeFileAtomic(resolvePath(), JSON.stringify(map, null, 2));
  return map;
}

/** One row of the screen: a GitHub project this machine holds, and what the map says of it. */
export interface EventProjectRow extends ProjectEventMap {
  repo: string;
}

/**
 * The projects the screen lists: every root this machine remembers whose
 * remote is on GitHub, one row per repo (a worktree shares its main
 * checkout's, whose root is the shortest), off unless the map says otherwise.
 * A project the map holds that the machine no longer lists stays, so it can
 * still be turned off.
 */
export function eventProjectRows(
  reports: readonly { root: string; remote: string | null; sub: string }[],
  map: EventMap = getEventMap(),
): EventProjectRow[] {
  const roots = new Map<string, string>();
  for (const r of reports) {
    if (r.sub !== "" || !r.remote?.startsWith("github.com/")) continue;
    const repo = r.remote.slice("github.com/".length);
    if (!isRepoSlug(repo)) continue;
    const have = roots.get(repo);
    if (!have || r.root.length < have.length) roots.set(repo, r.root);
  }
  const rows = new Map<string, EventProjectRow>();
  for (const [repo, root] of roots) {
    const mapped = map.projects[repo];
    rows.set(repo, mapped ? { repo, ...mapped } : { repo, enabled: false, root, events: { ...DEFAULT_EVENTS } });
  }
  for (const [repo, mapped] of Object.entries(map.projects)) if (!rows.has(repo)) rows.set(repo, { repo, ...mapped });
  return [...rows.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.repo.localeCompare(b.repo));
}
