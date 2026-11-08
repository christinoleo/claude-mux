/**
 * The state map: which of this machine's projects claude-mux may act on when
 * GitHub changes, and what it does for each event (#183).
 *
 * Kept in `~/.claude-mux/event-map.json`, next to the sessions, because it
 * belongs to the machine that holds the projects. Every GitHub project the
 * machine holds is on unless the file turns it off (#227): a project that is
 * not in the file takes `defaultEvents()`, where an issue marked ready starts
 * a session and a push is recorded as seen. The file holds only what a person
 * chose, so a new checkout is picked up on its own and a project turned off
 * stays off. The machine's switch (`src/server/machine-switch.ts`) is what
 * turns everything off at once.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { getSessionsDir } from "./sessions-json.js";
import { isRepoSlug } from "../github-ref.js";
import type { ProjectReport } from "../fleet-projects.js";

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

/** The repo whose pushes the release rule (`src/server/release.ts`) acts on. */
export const RELEASE_REPO = "christinoleo/claude-mux";

/**
 * What a project nobody has chosen for does with each event. claude-mux's
 * own push is ignored rather than given the rule, since the rule there is the
 * release: it runs on the one machine where someone chose it, never on every
 * machine that happens to hold a checkout.
 */
export function defaultEvents(repo: string): Record<EventKind, EventAction> {
  return { "issue-ready": "session", push: repo === RELEASE_REPO ? "ignore" : "rule" };
}

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

function parseProject(slug: string, raw: unknown): ProjectEventMap | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.root !== "string") return null;
  const events = defaultEvents(slug);
  const given = r.events && typeof r.events === "object" ? (r.events as Record<string, unknown>) : {};
  for (const kind of EVENT_KINDS) if (isEventAction(given[kind])) events[kind] = given[kind];
  // Only `false` turns a project off: that is the choice a person made.
  return { enabled: r.enabled !== false, root: r.root, events };
}

/** The map as the file holds it; null when the file exists but cannot be read as one. */
function readMap(): EventMap | null {
  let text: string;
  try {
    text = readFileSync(resolvePath(), "utf-8");
  } catch {
    return { v: 1, projects: {} };
  }
  try {
    const raw = JSON.parse(text) as { projects?: unknown };
    const projects: Record<string, ProjectEventMap> = {};
    if (raw.projects && typeof raw.projects === "object") {
      for (const [slug, value] of Object.entries(raw.projects as Record<string, unknown>)) {
        const project = parseProject(slug, value);
        if (isRepoSlug(slug) && project) projects[slug] = project;
      }
    }
    return { v: 1, projects };
  } catch {
    return null;
  }
}

/** The map; a torn or hand-broken file reads as empty rather than taking the server down. */
export function getEventMap(): EventMap {
  return readMap() ?? { v: 1, projects: {} };
}

/** A project root as `projectReports()` (`src/server/project-icons.ts`) reports it. */
export type HeldRoot = Pick<ProjectReport, "root" | "remote" | "sub">;

/** The projects that are on, by `owner/name`: those the machine holds, less those turned off. */
export function enabledProjects(held: readonly HeldRoot[], map: EventMap | null = readMap()): Map<string, ProjectEventMap> {
  return new Map(
    eventProjectRows(held, map)
      .filter((p) => p.enabled)
      .map(({ repo, ...p }) => [repo, p]),
  );
}

/** Whether a person turned this project off; not for a map that cannot be read, which forgets nothing. */
export function isTurnedOff(repo: string): boolean {
  return readMap()?.projects[repo]?.enabled === false;
}

export interface ProjectPatch {
  enabled?: boolean;
  root?: string;
  events?: Partial<Record<EventKind, EventAction>>;
}

/** Change one project; returns the map as it now stands. */
export function updateProjectEvents(slug: string, patch: ProjectPatch): EventMap {
  const map = readMap();
  // Writing over a file that cannot be read would lose every other project in it.
  if (!map) throw new Error(`${resolvePath()} cannot be read; fix or remove it first`);
  const have = map.projects[slug] ?? { enabled: true, root: patch.root ?? "", events: defaultEvents(slug) };
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
 * checkout's, whose root is the shortest), on unless the map says otherwise.
 * A project the map holds that the machine no longer lists stays, so it can
 * still be turned off.
 */
export function eventProjectRows(reports: readonly HeldRoot[], map: EventMap | null = readMap()): EventProjectRow[] {
  // A file that cannot be read may hold a project turned off: every row is off until it is fixed.
  if (!map) return eventProjectRows(reports, { v: 1, projects: {} }).map((row) => ({ ...row, enabled: false }));
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
    // The checkout where it is now, which a change on screen writes back to the map.
    rows.set(repo, mapped ? { repo, ...mapped, root } : { repo, enabled: true, root, events: defaultEvents(repo) });
  }
  for (const [repo, mapped] of Object.entries(map.projects)) if (!rows.has(repo)) rows.set(repo, { repo, ...mapped });
  return [...rows.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.repo.localeCompare(b.repo));
}
