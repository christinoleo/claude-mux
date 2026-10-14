/**
 * What this machine says about each project it remembers, for the fleet to
 * match one project across machines (`src/fleet-projects.ts`): the repo's
 * remote, where the root sits in the repo and under `~/Projects`, and its
 * icon, which is read here, on the machine that holds the repo, and served
 * by `GET /api/projects/icon?root=` (through the relay for other machines).
 *
 * Reading a project means running git and, outside a repo, walking part of
 * its tree, so it is never done on the poll's time: `projectReports()` answers from what is
 * known and starts a read in the background for a root that is new or has
 * gone stale. A root not read yet is left out, and the page guesses from the
 * path until the next broadcast has it.
 */

import { createHash } from "node:crypto";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";
import { imageMimeFor } from "../utils/image-types.js";
import {
  iconSources,
  isIconCandidate,
  normaliseRemote,
  siteIconUrl,
  type IconFile,
  type ProjectReport,
} from "../fleet-projects.js";
import { resolveInRoot } from "./files.js";
import { confinePath, git, repoRoot } from "./git.js";
import { readProjectConfig } from "./project.js";

/** How long what was read about a project stands before it is read again. */
const REFRESH_MS = 5 * 60_000;
/** A root nobody has asked about for this long is forgotten. */
const FORGET_MS = 30 * 60_000;
/** The largest icon kept; anything bigger is not an icon. */
const MAX_ICON_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
/** How deep, and over how many entries, a tree outside any repo is searched for an icon file. */
const WALK_DEPTH = 5;
const WALK_LIMIT = 20_000;
/** Folders that hold dependencies or build output, never the project's own icon. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor", "venv", "__pycache__", "coverage"]);

export interface ProjectIcon {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
}

export interface ProjectRead {
  report: ProjectReport;
  icon: ProjectIcon | null;
}

export interface ReadDeps {
  /** The directory `~/Projects` is matched against. */
  home?: string;
  fetch?: typeof fetch;
}

// The two icon formats the dashboard's shared image table leaves out: it
// serves project images without the sandbox an SVG would need.
const ICON_ONLY_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function iconType(path: string): string | null {
  return imageMimeFor(path) ?? ICON_ONLY_TYPES[extname(path).toLowerCase()] ?? null;
}

/** Read everything the fleet needs about the project at `root`. */
export async function readProject(root: string, deps: ReadDeps = {}): Promise<ProjectRead> {
  const home = confinePath(join(deps.home ?? homedir(), "Projects"), root);

  // git names the repo with its symlinks resolved, so the root is compared resolved too.
  const [repo, real] = await Promise.all([repoRoot(root), realpath(root).catch(() => root)]);
  const base = repo ?? real;
  const [remote, { config }, files] = await Promise.all([
    repo ? readRemote(repo) : null,
    readProjectConfig(base),
    findIconFiles(real, repo !== null),
  ]);
  const sub = repo && remote ? relative(repo, real) : "";
  const sources = iconSources({
    configIcon: config?.icon,
    // Found under the root; read from `base`, where the config's paths start too.
    files: files.map((f) => ({ ...f, path: relative(base, join(real, f.path)) })),
    prodUrl: config?.urls.prod ?? null,
  });

  let icon: ProjectIcon | null = null;
  for (const source of sources) {
    if (source.kind === "file") icon = await readIconFile(base, source.path);
    else if (source.kind === "url") icon = await fetchIcon(source.url, deps.fetch ?? fetch);
    else icon = await fetchSiteIcon(source.url, deps.fetch ?? fetch);
    if (icon) break;
  }
  const token = icon ? createHash("sha1").update(icon.bytes).digest("hex").slice(0, 12) : null;
  return { report: { root, remote, sub, home, icon: token }, icon };
}

async function readRemote(repo: string): Promise<string | null> {
  let url = await git(["remote", "get-url", "origin"], repo);
  if (!url) {
    const first = (await git(["remote"], repo))?.split("\n")[0]?.trim();
    if (first) url = await git(["remote", "get-url", first], repo);
  }
  return url ? normaliseRemote(url) : null;
}

/**
 * Every icon file under `root` in an icon folder, with a PNG's width. In a
 * repo git lists them, honouring its ignores, so no dependency or build tree
 * is walked; outside one the tree is walked within limits.
 */
async function findIconFiles(root: string, inRepo: boolean): Promise<IconFile[]> {
  const paths = inRepo ? await listIconFiles(root) : null;
  const rels = paths ?? (await walkIconFiles(root));
  return Promise.all(
    rels.map(async (rel) => ({ path: rel, width: rel.endsWith(".png") ? await pngWidth(join(root, rel)) : null })),
  );
}

/** The icon candidates git knows under `root` (paths from `root`); null when git fails. */
async function listIconFiles(root: string): Promise<string[] | null> {
  const out = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  if (out === null) return null;
  // An untracked dependency folder nobody ignored still holds no icon of the project's.
  const own = (rel: string) => !rel.split("/").some((p) => SKIP_DIRS.has(p) || p.startsWith("."));
  return [...new Set(out.split("\0"))].filter((rel) => rel && own(rel) && isIconCandidate(rel));
}

async function walkIconFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > WALK_DEPTH || seen > WALK_LIMIT) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) return;
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path, depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(root, path);
        if (isIconCandidate(rel)) found.push(rel);
      }
    }
  }
  await walk(root, 0);
  return found;
}

/** A PNG's width, from its header; null when it is not one. */
async function pngWidth(path: string): Promise<number | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(24);
      await handle.read(buf, 0, 24, 0);
      return buf.toString("latin1", 12, 16) === "IHDR" ? buf.readUInt32BE(16) : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readIconFile(base: string, path: string): Promise<ProjectIcon | null> {
  const type = iconType(path);
  if (!type) return null;
  try {
    // Through the real path, so a symlink out of the repo is not read and served.
    const { abs } = await resolveInRoot(base, path);
    const s = await stat(abs);
    if (!s.isFile() || s.size === 0 || s.size > MAX_ICON_BYTES) return null;
    return { bytes: Uint8Array.from(await readFile(abs)), type };
  } catch {
    return null;
  }
}

interface Fetched {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
  /** Where the response came from, after redirects. */
  url: string;
}

/** A response's body, given up on once it passes `limit` bytes rather than read whole first. */
async function fetchBody(url: string, fetcher: typeof fetch, limit: number): Promise<Fetched | null> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok || !res.body) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    if (size === 0) return null;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { bytes, type: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), url: res.url || url };
  } catch {
    return null;
  }
}

async function fetchIcon(url: string, fetcher: typeof fetch): Promise<ProjectIcon | null> {
  const body = await fetchBody(url, fetcher, MAX_ICON_BYTES);
  if (!body) return null;
  let type = body.type;
  if (!type.startsWith("image/")) {
    // Some servers send an icon as octet-stream, or with no type at all; the
    // name still says what it is. Anything else (an app's index.html served
    // for every path) is not an icon.
    if (type && type !== "application/octet-stream") return null;
    type = iconType(new URL(url).pathname) ?? "";
  }
  return type ? { bytes: body.bytes, type } : null;
}

async function fetchSiteIcon(pageUrl: string, fetcher: typeof fetch): Promise<ProjectIcon | null> {
  const page = await fetchBody(pageUrl, fetcher, MAX_PAGE_BYTES);
  const html = page && page.type.includes("html") ? new TextDecoder().decode(page.bytes) : "";
  // Its links are relative to where the page ended up, after any redirect.
  return fetchIcon(siteIconUrl(html, page?.url ?? pageUrl), fetcher);
}

// ── the cache the broadcast reads ────────────────────────────────────────────

interface Entry {
  read: ProjectRead | null;
  at: number;
  seenAt: number;
  inflight: boolean;
}

// On `globalThis`: under the dev server the broadcast and the icon route load
// this module separately, and the route must see what the broadcast read.
const g = globalThis as typeof globalThis & { __claudeMuxProjectReads?: Map<string, Entry> };
const cache = (g.__claudeMuxProjectReads ??= new Map<string, Entry>());

/**
 * What is known about each of `roots`, in their order; a root not read yet
 * is left out. Starts a read for any root that is new or stale.
 */
export function projectReports(roots: readonly string[], deps: ReadDeps = {}): ProjectReport[] {
  const now = Date.now();
  const out: ProjectReport[] = [];
  for (const root of roots) {
    let entry = cache.get(root);
    if (!entry) {
      entry = { read: null, at: 0, seenAt: now, inflight: false };
      cache.set(root, entry);
    }
    entry.seenAt = now;
    if (entry.read) out.push(entry.read.report);
    if (entry.inflight || now - entry.at < REFRESH_MS) continue;
    entry.inflight = true;
    const e = entry;
    void readProject(root, deps)
      .then((read) => {
        e.read = read;
      })
      .catch(() => {})
      .finally(() => {
        e.inflight = false;
        e.at = Date.now();
      });
  }
  for (const [root, entry] of cache) {
    if (now - entry.seenAt > FORGET_MS) cache.delete(root);
  }
  return out;
}

/** The icon of a project this machine has read; null for any other path. */
export function projectIcon(root: string): ProjectIcon | null {
  return cache.get(root)?.read?.icon ?? null;
}

/** Forget everything read; for tests. */
export function resetProjectReports(): void {
  cache.clear();
}
