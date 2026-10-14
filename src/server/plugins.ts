/**
 * This machine's Claude Code plugins, for the fleet to keep in step
 * (`src/fleet-plugins.ts`): its marketplaces with the commit each is at and
 * the latest commit its source has, and its installed plugins with their
 * version. Read through the `claude plugin` CLI, never off its files, so the
 * report says what Claude Code itself would.
 *
 * Reading runs the CLI and asks GitHub, so it is never done on the poll's
 * time: `PluginReader.current()` answers with what is known and reads again in the
 * background once the last attempt is older than REFRESH_MS. `align()` runs
 * one request of "Bring in line": `claude plugin marketplace update`, or an
 * install or enable of the plan, and a fresh read.
 *
 * Only user-scope plugins are reported; what a project turns on is its own.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { normaliseRemote } from "../fleet-projects.js";
import { isRepoSlug } from "../github-ref.js";
import type { AlignRequest, MarketplaceReport, PluginReport, PluginsReport } from "../fleet-plugins.js";

/** How long a report stands before it is read again. */
const REFRESH_MS = 5 * 60_000;
/** How long the latest commit of a marketplace's source stands. */
const LATEST_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 90_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

interface PluginDeps {
  run?: Runner;
  now?: () => number;
  /** Reads a file's text; null when it is not there. */
  readText?: (path: string) => Promise<string | null>;
}

/**
 * `claude` is usually in `~/.local/bin`, which a service's PATH may leave
 * out, so that and Claude Code's own install folder are searched too.
 */
const RUN_PATH = [process.env.PATH ?? "", join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")]
  .filter(Boolean)
  .join(delimiter);

const defaultRun: Runner = (cmd, args, timeoutMs) =>
  new Promise((done) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: RUN_PATH } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr || (err && code === -1 ? err.message : "")) });
      },
    );
  });

const defaultReadText = (path: string) => readFile(path, "utf8").catch(() => null);

interface CliMarketplace {
  name?: unknown;
  source?: unknown;
  repo?: unknown;
  url?: unknown;
  installLocation?: unknown;
}

interface CliPlugin {
  id?: unknown;
  version?: unknown;
  scope?: unknown;
  enabled?: unknown;
}

function parseJson<T>(text: string): T[] {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit a marketplace's checkout is at: its git HEAD, or the `.gcs-sha`
 * Claude Code writes beside one it downloaded as an archive.
 */
async function localCommit(location: string, run: Runner, readText: (path: string) => Promise<string | null>): Promise<string | null> {
  const head = await run("git", ["-C", location, "rev-parse", "HEAD"], READ_TIMEOUT_MS);
  const sha = head.stdout.trim();
  if (head.code === 0 && SHA.test(sha)) return sha;
  const gcs = (await readText(join(location, ".gcs-sha")))?.trim() ?? "";
  return SHA.test(gcs) ? gcs : null;
}

/** GitHub's own name for a repo (a renamed one answers under its new name) and its default branch's head. */
async function askGithub(repo: string, run: Runner): Promise<{ repo: string; latest: string } | null> {
  const res = await run("gh", ["api", `repos/${repo}`, "--jq", ".full_name"], READ_TIMEOUT_MS);
  const name = res.stdout.trim();
  if (res.code !== 0 || !isRepoSlug(name)) return null;
  const head = await run("gh", ["api", `repos/${name}/commits/HEAD`, "--jq", ".sha"], READ_TIMEOUT_MS);
  const sha = head.stdout.trim();
  return head.code === 0 && SHA.test(sha) ? { repo: name, latest: sha } : null;
}

/** A source's head through git itself, for a machine without `gh`. */
async function lsRemote(url: string, run: Runner): Promise<string | null> {
  const res = await run("git", ["ls-remote", url, "HEAD"], READ_TIMEOUT_MS);
  const sha = res.stdout.split(/\s/)[0];
  return res.code === 0 && SHA.test(sha) ? sha : null;
}

type Source = { repo: string; latest: string | null };

export class PluginReader {
  private report: PluginsReport | null = null;
  private reading: Promise<PluginsReport | null> | null = null;
  /** When the last read started, so a CLI that fails is not run again on every broadcast. */
  private attemptedAt = -Infinity;
  private sources = new Map<string, { at: number; source: Source }>();
  private readonly run: Runner;
  private readonly now: () => number;
  private readonly readText: (path: string) => Promise<string | null>;

  constructor(deps: PluginDeps = {}) {
    this.run = deps.run ?? defaultRun;
    this.now = deps.now ?? Date.now;
    this.readText = deps.readText ?? defaultReadText;
  }

  /** What is known now, starting a read in the background when the last one is stale. */
  current(): PluginsReport | null {
    if (this.now() - this.attemptedAt > REFRESH_MS && !this.reading) void this.read();
    return this.report;
  }

  /** Read the report now; a read already under way is joined. Null when the CLI cannot be run. */
  read(): Promise<PluginsReport | null> {
    if (!this.reading) this.attemptedAt = this.now();
    this.reading ??= this.readNow().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /** Read again after whatever read is under way, so the report reflects everything done before the call. */
  async refresh(): Promise<PluginsReport | null> {
    await this.reading;
    return this.read();
  }

  /**
   * Part of "Bring in line": update every marketplace when asked, then install
   * and enable what the request names, each step run whatever the one before
   * did, and read the report again so the fleet sees the result.
   */
  async align(plan: AlignRequest): Promise<{ steps: AlignStep[]; report: PluginsReport | null }> {
    const commands: string[][] = plan.update ? [["plugin", "marketplace", "update"]] : [];
    for (const step of plan.install) {
      commands.push(
        "marketplace" in step
          ? ["plugin", "install", `${step.name}@${step.marketplace}`]
          : ["plugin", "install", step.name, "--marketplace", step.repo],
      );
    }
    for (const id of plan.enable) commands.push(["plugin", "enable", id, "--scope", "user"]);

    const steps: AlignStep[] = [];
    for (const args of commands) {
      const res = await this.run("claude", args, STEP_TIMEOUT_MS);
      steps.push({ command: `claude ${args.join(" ")}`, ok: res.code === 0, output: `${res.stdout}${res.stderr}`.trim() });
    }
    return { steps, report: await this.refresh() };
  }

  private async readNow(): Promise<PluginsReport | null> {
    const [mps, pls] = await Promise.all([
      this.run("claude", ["plugin", "marketplace", "list", "--json"], READ_TIMEOUT_MS),
      this.run("claude", ["plugin", "list", "--json"], READ_TIMEOUT_MS),
    ]);
    if (mps.code !== 0 || pls.code !== 0) {
      console.warn("[plugins] could not read:", (mps.stderr || pls.stderr).trim().split("\n")[0]);
      return this.report;
    }
    const marketplaces = await Promise.all(parseJson<CliMarketplace>(mps.stdout).map((m) => this.marketplace(m)));
    const plugins: PluginReport[] = parseJson<CliPlugin>(pls.stdout)
      .filter((p) => typeof p.id === "string" && (p.scope === undefined || p.scope === "user"))
      .map((p) => ({
        id: p.id as string,
        version: typeof p.version === "string" ? p.version : null,
        enabled: p.enabled !== false,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const report: PluginsReport = {
      marketplaces: marketplaces.filter((m): m is MarketplaceReport => m !== null),
      plugins,
      readAt: this.now(),
    };
    this.report = report;
    return report;
  }

  private async marketplace(m: CliMarketplace): Promise<MarketplaceReport | null> {
    if (typeof m.name !== "string") return null;
    const location = typeof m.installLocation === "string" ? m.installLocation : null;
    // A GitHub repo added by URL is asked about as one added from GitHub.
    const github =
      m.source === "github" && typeof m.repo === "string"
        ? m.repo
        : typeof m.url === "string"
          ? /^github\.com\/([^/]+\/[^/]+)$/.exec(normaliseRemote(m.url) ?? "")?.[1]
          : undefined;
    const written = github ?? (typeof m.url === "string" ? m.url : null);
    const [commit, source] = await Promise.all([
      location ? localCommit(location, this.run, this.readText) : null,
      this.source(github, written),
    ]);
    return { name: m.name, repo: source?.repo ?? written, commit, latest: source?.latest ?? null };
  }

  private async source(github: string | undefined, written: string | null): Promise<Source | null> {
    if (!written) return null;
    const cached = this.sources.get(written);
    if (cached && this.now() - cached.at < LATEST_MS) return cached.source;
    let source: Source | null = null;
    if (github) {
      source = (await askGithub(github, this.run)) ?? { repo: github, latest: await lsRemote(`https://github.com/${github}.git`, this.run) };
    } else {
      source = { repo: written, latest: await lsRemote(written, this.run) };
    }
    if (source) this.sources.set(written, { at: this.now(), source });
    return source;
  }
}

export interface AlignStep {
  command: string;
  ok: boolean;
  output: string;
}

type GlobalWithPlugins = typeof globalThis & { __claudeMuxPlugins?: PluginReader };

/** This process's one reader (the dev server loads modules more than once). */
export function pluginReader(): PluginReader {
  const g = globalThis as GlobalWithPlugins;
  return (g.__claudeMuxPlugins ??= new PluginReader());
}
