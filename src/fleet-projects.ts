/**
 * One project across machines (spec #92, GLOSSARY.md "Project").
 *
 * Each machine reports, for every project root it remembers, the facts the
 * match needs (`ProjectReport`): the repo's normalised git remote, where the
 * root sits in that repo, where it sits under `~/Projects`, and whether it
 * has an icon. `projectKey()` turns those into one key, the same on every
 * machine that holds the project, so `claude-watch` on one machine and
 * `claude-mux` on another, both clones of the same remote, are one project:
 *
 * - with a remote, the remote (and the folder inside the repo, for a project
 *   that is a subfolder of one);
 * - without one, the folder's path under `~/Projects`;
 * - outside `~/Projects`, the machine and the full path: nothing else says
 *   two such folders are the same thing.
 *
 * Which icon a project shows is decided on the machine that holds it
 * (`iconSources()`, `pickIconFile()`; `src/server/project-icons.ts` does the
 * reading); across machines the first one with an icon wins. A project
 * without one is drawn as its initials on a hue derived from its name.
 */

import { z } from "zod/v4";

export const ProjectReportSchema = z.object({
  /** The project's root on the reporting machine. */
  root: z.string(),
  /** The repo's `origin`, normalised (`normaliseRemote()`); null outside a repo or without one. */
  remote: z.string().nullable(),
  /** Where the root sits in its repo: '' at the repo's root. */
  sub: z.string(),
  /** The root's path under `~/Projects`; null when it is not under it. */
  home: z.string().nullable(),
  /** A token that changes with the icon's bytes; null when the project has none. */
  icon: z.string().nullable(),
});

export type ProjectReport = z.infer<typeof ProjectReportSchema>;

/**
 * A git remote reduced to `host/owner/name`, lower-cased, so the HTTPS and
 * SSH spellings of one repo, with or without `.git`, compare equal.
 */
export function normaliseRemote(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  // scp-like: git@github.com:owner/name.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const u = new URL(s);
      if (u.protocol === "file:") s = u.pathname;
      else s = `${u.hostname}${u.pathname}`;
    } catch {
      // A plain path: a local remote.
    }
  }
  s = s
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+/g, "/");
  return s ? s.toLowerCase() : null;
}

/** The key one project goes by on every machine that holds it. */
export function projectKey(machineId: string, report: ProjectReport): string {
  if (report.remote) return `git:${report.remote}${report.sub ? `/${report.sub}` : ""}`;
  if (report.home) return `dir:${report.home}`;
  return `path:${machineId}:${report.root}`;
}

/** The folder a report names: its path under `~/Projects`, else its last part. */
function folderName(report: ProjectReport): string {
  return report.home ?? report.root.split("/").filter(Boolean).pop() ?? report.root;
}

/** The repo's own name, with the folder inside it for a subfolder project; null without a remote. */
function repoName(report: ProjectReport): string | null {
  if (!report.remote) return null;
  const repo = report.remote.split("/").pop() ?? report.remote;
  return report.sub ? `${repo}/${report.sub}` : repo;
}

/**
 * What a project is called. One without a remote goes by its folder. One with
 * a remote goes by the repo's name when some machine's folder is called that
 * (`claude-watch` here and `claude-mux` there are `claude-mux`), and otherwise
 * by the folder on the first machine, the name a person gave it.
 */
export function projectName(reports: readonly ProjectReport[]): string {
  const repo = repoName(reports[0]);
  const folders = reports.map(folderName);
  return repo && folders.includes(repo) ? repo : folders[0];
}

/**
 * The report a machine would send for a root it has not described: from an
 * older claude-mux, or a root that appeared since its last report. Without a
 * remote to go by it is matched by its place under `~/Projects`, read off the
 * path, and marked `guessed` so the merge may still join it to a repo of the
 * same name (`mergeProjects()`).
 */
export function guessReport(root: string): ProjectReport & { guessed: true } {
  const home = /^\/(?:home|Users)\/[^/]+\/Projects\/(.+)$/.exec(root)?.[1] ?? null;
  return { root, remote: null, sub: "", home, icon: null, guessed: true };
}

/** Where one machine holds a project. */
export interface ProjectPlace {
  machineId: string;
  root: string;
}

/** One project, wherever it is held. */
export interface FleetProject {
  key: string;
  name: string;
  /** In the order the machines were given, and within one machine in report order. */
  places: ProjectPlace[];
  /** The icon shown: the first place with one. */
  icon: (ProjectPlace & { token: string }) | null;
}

type MergeInput = readonly { id: string; reports: readonly (ProjectReport & { guessed?: boolean })[] }[];

/**
 * Lay every machine's projects together, one entry per project. Machines
 * come in priority order (the origin first): the first that has an icon for
 * a project is the one whose icon is shown.
 *
 * A guessed report (`guessReport()`) says nothing of a remote, so on its own
 * it could never meet the same repo reported properly elsewhere. It joins the
 * one repo project whose name, or one of whose folders, is its folder under
 * `~/Projects`; with none, or more than one, it stands by its folder.
 */
export function mergeProjects(machines: MergeInput): FleetProject[] {
  const order = new Map(machines.map((m, i) => [m.id, i]));
  const byKey = new Map<string, { reports: ProjectReport[]; places: ProjectPlace[] }>();
  const add = (key: string, machineId: string, report: ProjectReport) => {
    let entry = byKey.get(key);
    if (!entry) byKey.set(key, (entry = { reports: [], places: [] }));
    entry.reports.push(report);
    entry.places.push({ machineId, root: report.root });
  };
  const guessed: { machineId: string; report: ProjectReport }[] = [];
  for (const machine of machines) {
    for (const report of machine.reports) {
      if (report.guessed && report.home) guessed.push({ machineId: machine.id, report });
      else add(projectKey(machine.id, report), machine.id, report);
    }
  }
  for (const { machineId, report } of guessed) {
    const repos = [...byKey].filter(
      ([key, e]) => key.startsWith("git:") && (repoName(e.reports[0]) === report.home || e.reports.some((r) => folderName(r) === report.home))
    );
    add(repos.length === 1 ? repos[0][0] : projectKey(machineId, report), machineId, report);
  }

  return [...byKey].map(([key, { reports, places }]) => {
    const ranked = places
      .map((place, i) => ({ place, report: reports[i] }))
      .sort((a, b) => order.get(a.place.machineId)! - order.get(b.place.machineId)!);
    const withIcon = ranked.find((r) => r.report.icon);
    return {
      key,
      name: projectName(ranked.map((r) => r.report)),
      places: ranked.map((r) => r.place),
      icon: withIcon ? { ...withIcon.place, token: withIcon.report.icon! } : null,
    };
  });
}

/** Two letters for a project without an icon: `claude-mux` → `CM`, `zapSell` → `ZS`, `random` → `RA`. */
export function projectInitials(name: string): string {
  const base = name.split("/").filter(Boolean).pop() ?? name;
  const parts = base.split(/[-_.\s]+|(?=[A-Z])/).filter((p) => /[a-z0-9]/i.test(p));
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : base.replace(/[^a-z0-9]/gi, "").slice(0, 2);
  return (letters || "?").toUpperCase();
}

/**
 * The hues a project's initials may take. They keep clear of what other
 * marks already mean: amber (a session wants a person), emerald (working or
 * done), red (failed), violet and teal (workers and subagents), and the
 * machines' own hues (sky, fuchsia, lime).
 */
export const PROJECT_HUES = [14, 26, 118, 132, 222, 236, 318, 336] as const;

/** The hue a project's initials are drawn in: from its name, so it is the same on every machine and link. */
export function projectHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROJECT_HUES[h % PROJECT_HUES.length];
}

// ── icon resolution ─────────────────────────────────────────────────────────

/** The file names that are a project's icon, and the folders they count in. */
const ICON_FILE_NAMES = ["favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png", "apple-touch-icon.png"];
const ICON_DIRS = ["static", "public", "app"];

/** A file found in the repo that may be its icon: its path from the root, and a PNG's width when known. */
export interface IconFile {
  path: string;
  width?: number | null;
}

/** Whether a path from the project's root names an icon file in one of the icon folders (or below one). */
export function isIconCandidate(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop()!;
  return ICON_FILE_NAMES.includes(name) && parts.some((p) => ICON_DIRS.includes(p));
}

/**
 * The repo's own icon among the files found: an SVG first (a favicon over an
 * icon, then the shallowest), then the widest PNG, then an ICO.
 */
export function pickIconFile(files: readonly IconFile[]): string | null {
  const found = files.filter((f) => isIconCandidate(f.path));
  const ext = (f: IconFile) => f.path.slice(f.path.lastIndexOf(".") + 1);
  const depth = (f: IconFile) => f.path.split("/").length;
  const named = (f: IconFile) => (f.path.endsWith("/favicon.svg") ? 0 : 1);
  const rank: Record<string, number> = { svg: 0, png: 1, ico: 2 };
  // One order for all three: the name only differs among SVGs, the width only among PNGs.
  const best = found
    .filter((f) => ext(f) in rank)
    .sort(
      (a, b) =>
        rank[ext(a)] - rank[ext(b)] ||
        named(a) - named(b) ||
        (b.width ?? 0) - (a.width ?? 0) ||
        depth(a) - depth(b) ||
        a.path.localeCompare(b.path),
    );
  return best[0]?.path ?? null;
}

/** Where an icon can come from, in the order they are tried. */
export type IconSource =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }
  | { kind: "site"; url: string };

/**
 * Where to look for a project's icon, first found wins: `icon` in
 * `.claude-mux.json` (a URL, or a path in the repo), then the repo's own icon
 * file, then the favicon of the prod site `.claude-mux.json` names.
 */
export function iconSources(input: {
  configIcon?: string | null;
  files: readonly IconFile[];
  prodUrl?: string | null;
}): IconSource[] {
  const out: IconSource[] = [];
  const given = input.configIcon?.trim();
  if (given) {
    if (/^https?:\/\//i.test(given)) out.push({ kind: "url", url: given });
    else {
      const path = given.replace(/^\.?\/+/, "");
      if (path && !path.split("/").includes("..")) out.push({ kind: "file", path });
    }
  }
  const file = pickIconFile(input.files);
  if (file) out.push({ kind: "file", path: file });
  if (input.prodUrl) out.push({ kind: "site", url: input.prodUrl });
  return out;
}

/**
 * The icon a page links to, from its HTML: the `<link rel="icon">` (or
 * `shortcut icon`, `apple-touch-icon`) that is an SVG, else the largest, else
 * `/favicon.ico`. Resolved against the page's URL.
 */
export function siteIconUrl(html: string, pageUrl: string): string {
  const links: { href: string; svg: boolean; size: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    // An attribute's value, double-quoted, single-quoted or bare.
    const attr = (name: string) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
      return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    };
    const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    const href = attr("href");
    if (!href) continue;
    const size = Number(/(\d+)x\d+/.exec(attr("sizes") ?? "")?.[1] ?? 0);
    const svg = /svg/i.test(attr("type") ?? "") || /\.svg(?:[?#]|$)/i.test(href);
    links.push({ href, svg, size });
  }
  links.sort((a, b) => Number(b.svg) - Number(a.svg) || b.size - a.size);
  try {
    return new URL(links[0]?.href ?? "/favicon.ico", pageUrl).href;
  } catch {
    return new URL("/favicon.ico", pageUrl).href;
  }
}
