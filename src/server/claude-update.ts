/**
 * Keeps Claude Code up to date on this machine, without anyone asking.
 *
 * Two jobs run here, and they fail differently. Installing happens once per
 * machine, outside any pane, because a machine has one binary: the server asks
 * the installer that owns the binary for the newest release at least a day old,
 * installs that exact version and believes only `claude --version` afterwards.
 * An installation that updates itself (the native one) is left to do so.
 *
 * Restarting is the job that can hurt, since it ends a live process, so every
 * doubt refuses (`restartRefusal()`). A session that never qualifies stays on
 * the old version with Claude Code's own notice, which costs nothing.
 *
 * What must survive a restart of claude-mux lives in one file: the attempts per
 * version, which is what stops a failing install from looping, and the restart
 * given to each session per version, written before the restart happens. Only
 * the built server runs this (`hooks.server.ts`), and only one per machine, so
 * a dev server beside it never touches the real installation.
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { getAllSessions, getSession, type Session } from "../db/sessions-json.js";
import { getSettings } from "../db/settings-json.js";
import { capturePaneContentAsync, isDialogOpen, isPromptBoxClear, readPaneHold, readUpdateNotice, runTmux, stripAnsi, type UpdateNotice } from "../tmux/pane.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";
import { isPidAlive } from "../utils/pid.js";
import { descendants, readProcessTable, type ProcessRow } from "../utils/processes.js";
import { getQueue } from "./message-queue.js";
import { claudeSessionsDir } from "./remote-control.js";
import { readLaunchArgs, restartClaude, sessionPath, type RestartOutcome } from "./restart-claude.js";

/** How old a release must be before it is installed. */
export const PUBLISH_WAIT_MS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 2;
export const ATTEMPT_GAP_MS = 60 * 60_000;
/** How long a session must have been idle before it may be restarted. */
export const IDLE_BEFORE_RESTART_MS = 10 * 60_000;

/** How often the sessions are looked at, and how often the installer is. */
const TICK_MS = 60_000;
const CHECK_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const QUERY_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 5 * TICK_MS;
/** How much of a failed install's output is kept to show. */
const OUTPUT_TAIL = 2_000;

const NPM_PACKAGE = "@anthropic-ai/claude-code";

type Release = {
  version: string;
  /** When it was published, or null when this installer cannot say. */
  publishedAt: number | null;
};

export type ClaudeUpdateStatus = {
  state: "self-updating" | "unknown-installer" | "current" | "waiting" | "retrying" | "installing" | "failed";
  /** What `claude --version` reports here, when it answers. */
  installed: string | null;
  /** The version being waited for, installed, or given up on. */
  target: string | null;
  /** When a waiting or retrying version gets its turn. */
  at?: number;
  /** What the last failed attempt printed. */
  output?: string;
};

type UpdateFile = {
  /** When this machine first saw a version whose installer gives no date. */
  firstSeen: Record<string, number>;
  attempts: Record<string, { count: number; lastAt: number; output?: string }>;
  /** The installed version each session was last restarted for. */
  restarted: Record<string, string>;
  status: ClaudeUpdateStatus | null;
};

const CLAUDE_UPDATE_FILE = join(CLAUDE_MUX_DIR, "claude-update.json");
const LOCK_FILE = join(CLAUDE_MUX_DIR, "claude-update.lock");

function readUpdateFile(path: string): UpdateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<UpdateFile>;
    return {
      firstSeen: parsed.firstSeen ?? {},
      attempts: parsed.attempts ?? {},
      restarted: parsed.restarted ?? {},
      status: parsed.status ?? null,
    };
  } catch {
    return { firstSeen: {}, attempts: {}, restarted: {}, status: null };
  }
}

/** How this machine's updates stand, for the Machines view and the broadcast. */
export function readClaudeUpdateStatus(path = CLAUDE_UPDATE_FILE): ClaudeUpdateStatus | null {
  return readUpdateFile(path).status;
}

/** Negative when `a` is older than `b`. Only plain x.y.z versions reach this. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

type InstallDecision =
  | { state: "current"; target: null }
  | { state: "waiting" | "retrying"; target: string; at: number }
  | { state: "installing" | "failed"; target: string };

/**
 * What to do about the releases an installer knows. The target is the newest
 * release old enough, not the newest release: Claude Code publishes about once
 * a day, so waiting for the newest to reach 24 hours might wait forever. A
 * version with no date counts from when this machine first saw it, and stays a
 * candidate after the installer moves on: a cask only ever names its newest, so
 * otherwise each release would restart the wait. `failed` belongs to one target,
 * so a newer one reaching its day clears it.
 */
export function decideInstall(input: {
  releases: Release[];
  installed: string;
  firstSeen: Record<string, number>;
  attempts: UpdateFile["attempts"];
  now: number;
}): InstallDecision {
  const { installed, firstSeen, attempts, now } = input;
  const known = new Set(input.releases.map((r) => r.version));
  const remembered = Object.keys(firstSeen).filter((version) => !known.has(version));
  const newer = [...input.releases, ...remembered.map((version) => ({ version, publishedAt: null }))]
    .filter((r) => compareVersions(r.version, installed) > 0)
    .map((r) => ({ version: r.version, since: r.publishedAt ?? firstSeen[r.version] ?? now }))
    .sort((a, b) => compareVersions(b.version, a.version));
  const ready = newer.find((r) => now - r.since >= PUBLISH_WAIT_MS);
  if (!ready) {
    const next = newer.at(-1);
    return next ? { state: "waiting", target: next.version, at: next.since + PUBLISH_WAIT_MS } : { state: "current", target: null };
  }
  const tried = attempts[ready.version];
  if (!tried) return { state: "installing", target: ready.version };
  if (tried.count >= MAX_ATTEMPTS) return { state: "failed", target: ready.version };
  const at = tried.lastAt + ATTEMPT_GAP_MS;
  return now >= at ? { state: "installing", target: ready.version } : { state: "retrying", target: ready.version, at };
}

/** A command's result; `ok` is its exit status, which says nothing about whether an update took. */
type ExecResult = { ok: boolean; stdout: string; stderr: string };
export type Exec = (command: string, args: string[], options: { path: string; timeoutMs: number; cwd?: string }) => Promise<ExecResult>;

const exec: Exec = (command, args, { path, timeoutMs, cwd }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        // Home by default, so a project's own tool config in the server's cwd has no say.
        cwd: cwd ?? homedir(),
        env: { ...process.env, PATH: path, MISE_YES: "1" },
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) =>
        // A command that cannot start prints nothing, so its error is what there is to show.
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) || (err?.message ?? "") })
    );
  });

type Installer = {
  /** The releases it can install, newest or not; null when it will not say. */
  releases(run: Exec, path: string): Promise<Release[] | null>;
  /** The argv that installs `version`. */
  install(version: string): [string, string[]];
};

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

function parseDate(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : at;
}

function parseJson(result: ExecResult): unknown {
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** mise reads its dates from the GitHub releases it installs from; `install`, unlike `upgrade`, can name a version. */
function miseInstaller(tool: string): Installer {
  return {
    async releases(run, path) {
      const list = parseJson(await run("mise", ["ls-remote", tool, "--json"], { path, timeoutMs: QUERY_TIMEOUT_MS }));
      if (!Array.isArray(list)) return null;
      return (list as { version?: unknown; created_at?: unknown }[]).flatMap((r) =>
        typeof r.version === "string" && PLAIN_VERSION.test(r.version)
          ? [{ version: r.version, publishedAt: parseDate(r.created_at) }]
          : []
      );
    },
    install: (version) => ["mise", ["install", `${tool}@${version}`]],
  };
}

/** The registry dates every version. Nothing past the `latest` tag is offered, since `next` may carry more. */
const npmInstaller: Installer = {
  async releases(run, path) {
    const view = parseJson(await run("npm", ["view", NPM_PACKAGE, "time", "dist-tags", "--json"], { path, timeoutMs: QUERY_TIMEOUT_MS })) as
      | { time?: Record<string, string>; "dist-tags"?: { latest?: string } }
      | null;
    const latest = view?.["dist-tags"]?.latest;
    if (!view?.time || !latest || !PLAIN_VERSION.test(latest)) return null;
    return Object.entries(view.time).flatMap(([version, at]) =>
      PLAIN_VERSION.test(version) && compareVersions(version, latest) <= 0 ? [{ version, publishedAt: parseDate(at) }] : []
    );
  },
  install: (version) => ["npm", ["i", "-g", `${NPM_PACKAGE}@${version}`]],
};

/** A cask knows one version and no date, so the wait counts from when this machine first saw it. */
function brewInstaller(token: string): Installer {
  return {
    async releases(run, path) {
      const info = parseJson(await run("brew", ["info", "--json=v2", "--cask", token], { path, timeoutMs: QUERY_TIMEOUT_MS })) as
        | { casks?: { version?: unknown }[] }
        | null;
      const version = info?.casks?.[0]?.version;
      return typeof version === "string" && PLAIN_VERSION.test(version) ? [{ version, publishedAt: null }] : null;
    },
    install: () => ["brew", ["upgrade", "--cask", token]],
  };
}

/** The `claude` a PATH resolves to, as found and with its links followed. */
function locateClaude(path: string): { found: string; real: string } | null {
  for (const dir of path.split(":")) {
    const found = join(dir || ".", "claude");
    try {
      if (statSync(found).isFile()) return { found, real: realpathSync(found) };
    } catch {
      /* missing or unreadable: the next directory may do */
    }
  }
  return null;
}

/**
 * Who owns the binary, judged by where it lives. "self" means Claude Code
 * updates it itself; null means nobody claude-mux knows, so nothing is run.
 */
export function detectInstaller(location: { found: string; real: string } | null): Installer | "self" | null {
  if (!location) return null;
  const { found, real } = location;
  // Under MISE_DATA_DIR, which may be any directory with mise in its path.
  const MISE_INSTALL = /\/mise\/(?:.*\/)?installs\/(claude(?:-code)?)\//;
  const mise = MISE_INSTALL.exec(real) ?? MISE_INSTALL.exec(found);
  if (mise) return miseInstaller(mise[1]);
  if (found.includes("/mise/shims/")) return miseInstaller("claude");
  if (real.includes("/.local/share/claude/versions/")) return "self";
  // npm's own global layout only: bun's and pnpm's would gain a second copy from `npm i -g`.
  if (real.includes(`/lib/node_modules/${NPM_PACKAGE}/`) && !/\/(?:\.bun|pnpm|mise)\//.test(real)) return npmInstaller;
  const cask = /\/Caskroom\/(claude-code[^/]*)\//.exec(real);
  return cask ? brewInstaller(cask[1]) : null;
}

/**
 * Flags of Claude Code's that take a value. Anything else not starting with a
 * dash is read as a prompt, which errs towards refusing: an unknown flag's value
 * looks like one.
 */
const VALUE_FLAGS = new Set([
  "--model",
  "--permission-mode",
  "--setting-sources",
  "--effort",
  "--agent",
  "--settings",
  "--mcp-config",
  "--name",
  "-n",
  "--append-system-prompt",
  "--system-prompt",
  "--fallback-model",
]);

/**
 * Whether a launch carries a prompt. A restart replays the argv, so it would
 * send that prompt again as a new turn: a maestro worker is started with
 * `/ak:maestro-worker <issue>` and would pick its work up a second time.
 */
export function launchCarriesPrompt(argv: string[]): boolean {
  // `node /path/cli.js …`: the script is no prompt.
  const first = /^(?:node|bun)$/.test(basename(argv[0] ?? "")) ? 2 : 1;
  for (let i = first; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) i++;
    else if (!argv[i].startsWith("-")) return true;
  }
  return false;
}

/** The `Bash` tool's shell, which carries its snapshot or an `eval` of the command; MCP servers do not. */
const TOOL_SHELL = /shell-snapshots\/snapshot-|\beval\b/;

/** What a restart decision needs, read just before it is made. */
export type RestartFacts = {
  session: Pick<Session, "state" | "last_update" | "background_tasks" | "subagents" | "rc_url">;
  /** Messages claude-mux itself holds for this pane, which `readPaneHold()` cannot see. */
  queued: number;
  /** When the updater first saw this session idle without a break. */
  idleSince: number;
  now: number;
  /** The pane captured with colour; null when it could not be. */
  raw: string | null;
  /** What the process says it runs, in Claude Code's own record of it. */
  running: string | null;
  /** What `claude --version` reports on the session's PATH. */
  installed: string | null;
  /** The version this session was last restarted for. */
  restartedFor: string | null;
  /** The process and everything under it; null when the table cannot be read. */
  processes: ProcessRow[] | null;
  /** The argv a restart would replay. */
  launch: string[] | null;
  /** The process is the one in that pane, and not a stale record's. */
  ownsPane: boolean;
};

function idledLongEnough(session: Pick<Session, "last_update">, idleSince: number, now: number): boolean {
  return now - Math.max(session.last_update, idleSince) >= IDLE_BEFORE_RESTART_MS;
}

function offersRestart(notice: UpdateNotice | null): boolean {
  return notice?.kind === "installed" || notice?.kind === "available";
}

/** Why this session must not be restarted now, or null when nothing stands against it. */
export function restartRefusal(facts: RestartFacts): string | null {
  const { session, raw, running, installed, processes, launch, now } = facts;
  if (session.state !== "idle") return "not idle";
  if (!idledLongEnough(session, facts.idleSince, now)) return "idle for under 10 minutes";
  if (raw === null) return "pane unreadable";
  if (isDialogOpen(session.state, raw)) return "dialog open";
  const hold = readPaneHold(raw);
  if (hold) return `pane holds: ${hold}`;
  if (!isPromptBoxClear(raw)) return "prompt box not clear";
  if (facts.queued > 0) return "messages queued";
  if (!offersRestart(readUpdateNotice(stripAnsi(raw)))) return "no update notice";
  if ((session.background_tasks ?? 0) > 0 || (session.subagents?.length ?? 0) > 0) return "background tasks";
  // The bridge dies with the process and nothing brings it back.
  if (session.rc_url) return "Remote Control on";
  if (processes === null) return "process table unreadable";
  if (processes.some((row) => TOOL_SHELL.test(row.args))) return "background shell running";
  if (!facts.ownsPane) return "process is not in that pane";
  if (launch === null) return "launch unreadable";
  if (launchCarriesPrompt(launch)) return "launch carries a prompt";
  if (running === null || installed === null) return "version unknown";
  if (compareVersions(running, installed) >= 0) return "already on the installed version";
  if (facts.restartedFor === installed) return "already restarted for this version";
  return null;
}

/** The version a process says it runs, from Claude Code's record of it; null where it keeps none. */
export function processVersion(pid: number): string | null {
  try {
    const version: unknown = JSON.parse(readFileSync(join(claudeSessionsDir(), `${pid}.json`), "utf-8"))?.version;
    return typeof version === "string" && PLAIN_VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Whether `pid` is what runs in the pane, with no other Claude Code above it for a respawn to kill. */
export function paneRunsProcess(rows: ProcessRow[], panePid: number, pid: number): boolean {
  if (pid === panePid) return true;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let parent = byPid.get(byPid.get(pid)?.ppid ?? -1);
  while (parent) {
    if (basename(parent.args.split(/\s+/)[0]) === "claude") return false;
    if (parent.pid === panePid) return true;
    parent = byPid.get(parent.ppid);
  }
  return false;
}

/** Whether another live server on this machine already runs the updater. */
function heldElsewhere(lockPath: string): boolean {
  let holder = NaN;
  try {
    holder = Number(readFileSync(lockPath, "utf-8"));
  } catch {
    /* nobody holds it */
  }
  // The holder rewrites it every tick, so an old file is a pid reused after a crash, not a server.
  if (holder !== process.pid && Number.isInteger(holder) && holder > 0 && isPidAlive(holder)) {
    if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return true;
  }
  writeFileAtomic(lockPath, String(process.pid));
  return false;
}

export type UpdaterDeps = {
  statePath: string;
  lockPath: string;
  now: () => number;
  enabled: () => boolean;
  sessions: () => Session[];
  session: (id: string) => Session | null;
  /** The PATH a restart would resolve `claude` on. */
  pathOf: (session: Pick<Session, "pid"> | null) => string;
  locate: (path: string) => { found: string; real: string } | null;
  exec: Exec;
  capture: (target: string, withColor: boolean) => Promise<string | null>;
  processTable: () => Promise<ProcessRow[] | null>;
  panePid: (target: string) => Promise<number | null>;
  running: (session: Session) => string | null;
  queued: (target: string) => number;
  launch: (session: Session) => string[] | null;
  restart: (session: Session) => Promise<RestartOutcome>;
};

const REAL_DEPS: UpdaterDeps = {
  statePath: CLAUDE_UPDATE_FILE,
  lockPath: LOCK_FILE,
  now: Date.now,
  enabled: () => getSettings().autoUpdateClaude,
  sessions: getAllSessions,
  session: getSession,
  pathOf: (session) => (session ? sessionPath(session) : (process.env.PATH ?? "")),
  locate: locateClaude,
  exec,
  capture: capturePaneContentAsync,
  processTable: readProcessTable,
  panePid: async (target) => {
    const out = await runTmux(["display-message", "-p", "-t", target, "#{pane_pid}"]);
    return out !== null && /^\d+$/.test(out.trim()) ? Number(out.trim()) : null;
  },
  running: (session) => processVersion(session.pid),
  queued: (target) => getQueue(target).length,
  launch: (session) => readLaunchArgs(session.pid),
  restart: restartClaude,
};

export class ClaudeUpdater {
  private readonly deps: UpdaterDeps;
  private idleSince = new Map<string, number>();
  private lastCheck = -Infinity;
  private ticking = false;

  constructor(deps: Partial<UpdaterDeps> = {}) {
    this.deps = { ...REAL_DEPS, ...deps };
  }

  /** Change the file as it stands on disk, so nothing another writer saved is lost. */
  private save(change: (file: UpdateFile) => void): UpdateFile {
    const file = readUpdateFile(this.deps.statePath);
    change(file);
    writeFileAtomic(this.deps.statePath, JSON.stringify(file, null, 2));
    return file;
  }

  private setStatus(status: ClaudeUpdateStatus): void {
    this.save((file) => {
      file.status = status;
    });
  }

  private async versionOn(path: string, cwd?: string): Promise<string | null> {
    const { stdout } = await this.deps.exec("claude", ["--version"], { path, cwd, timeoutMs: VERSION_TIMEOUT_MS });
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null;
  }

  private liveClaudeSessions(): Session[] {
    return this.deps.sessions().filter(
      // A record can hold pid 0 when the hook found no process, and signal 0 to that always "succeeds".
      (s) => s.tmux_target && (s.agent ?? "claude") === "claude" && s.pid > 0 && isPidAlive(s.pid)
    );
  }

  /** One pass: the installer when it is due, then the sessions. Never rejects. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.deps.enabled() || heldElsewhere(this.deps.lockPath)) {
        this.idleSince.clear();
        return;
      }
      const now = this.deps.now();
      if (now - this.lastCheck >= CHECK_MS) {
        this.lastCheck = now;
        await this.checkInstall();
      }
      await this.restartEligible();
    } catch (err) {
      console.warn(`[claude-update] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** See whether an install is due, and run it. The attempt is counted first, so a crash mid-install still counts. */
  async checkInstall(): Promise<void> {
    const path = this.deps.pathOf(this.liveClaudeSessions()[0] ?? null);
    const installer = detectInstaller(this.deps.locate(path));
    const installed = await this.versionOn(path);
    if (installer === "self" || installer === null) {
      this.setStatus({ state: installer === "self" ? "self-updating" : "unknown-installer", installed, target: null });
      return;
    }
    // Success is judged by this version, so an install it could not judge is not started.
    if (installed === null) return;
    const releases = await installer.releases(this.deps.exec, path);
    if (releases === null) return;

    const now = this.deps.now();
    const file = this.save((f) => {
      for (const r of releases) {
        if (r.publishedAt === null) f.firstSeen[r.version] ??= now;
      }
      for (const version of [...Object.keys(f.firstSeen), ...Object.keys(f.attempts)]) {
        if (compareVersions(version, installed) <= 0) {
          delete f.firstSeen[version];
          delete f.attempts[version];
        }
      }
    });
    const decision = decideInstall({ releases, installed, firstSeen: file.firstSeen, attempts: file.attempts, now });
    if (decision.state === "installing") return this.install(installer, decision.target, installed, path);
    const output = decision.target === null ? undefined : file.attempts[decision.target]?.output;
    this.setStatus({ ...decision, installed, output });
  }

  private async install(installer: Installer, version: string, installed: string, path: string): Promise<void> {
    const { count } = this.save((f) => {
      f.attempts[version] = { count: (f.attempts[version]?.count ?? 0) + 1, lastAt: this.deps.now() };
      f.status = { state: "installing", installed, target: version };
    }).attempts[version];
    const [command, args] = installer.install(version);
    console.log(`[claude-update] attempt ${count} of ${MAX_ATTEMPTS}: ${command} ${args.join(" ")}`);
    const result = await this.deps.exec(command, args, { path, timeoutMs: INSTALL_TIMEOUT_MS });
    const after = await this.versionOn(path);
    // The exit status proves nothing: a shim or a pin can leave the old version in place.
    if (after !== null && compareVersions(after, version) >= 0) {
      this.save((f) => {
        delete f.attempts[version];
        f.status = { state: "current", installed: after, target: null };
      });
      return;
    }
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-OUTPUT_TAIL);
    this.save((f) => {
      f.attempts[version] = { count, lastAt: this.deps.now(), output };
      f.status =
        count >= MAX_ATTEMPTS
          ? { state: "failed", installed: after, target: version, output }
          : { state: "retrying", installed: after, target: version, at: this.deps.now() + ATTEMPT_GAP_MS, output };
    });
  }

  /** Restart whatever qualifies, one at a time. Most sessions fall out before a single command runs. */
  async restartEligible(): Promise<void> {
    const now = this.deps.now();
    const live = this.liveClaudeSessions();
    const idle = live.filter((s) => s.state === "idle");
    this.idleSince = new Map(idle.map((s) => [s.id, this.idleSince.get(s.id) ?? now]));
    const candidates = idle.filter((s) => idledLongEnough(s, this.idleSince.get(s.id)!, now));
    for (const candidate of candidates) await this.considerRestart(candidate);
  }

  private async considerRestart(candidate: Session): Promise<void> {
    const target = candidate.tmux_target!;
    // The plain capture is what saves the rest for the usual session: no notice, nothing to do.
    const seen = await this.deps.capture(target, false);
    if (!offersRestart(seen ? readUpdateNotice(seen) : null)) return;

    // In its own directory, as a restart would start it: a project may pin a version.
    const installed = await this.versionOn(this.deps.pathOf(candidate), candidate.cwd);
    // The usual end for a notice that only says a release exists, so it too saves the rest.
    const wrote = this.deps.running(candidate);
    if (wrote && installed && compareVersions(wrote, installed) >= 0) return;

    const rows = await this.deps.processTable();
    const panePid = await this.deps.panePid(target);
    const restarted = readUpdateFile(this.deps.statePath).restarted;
    const raw = await this.deps.capture(target, true);

    // Read after every wait, with nothing awaited from here to the restart: a
    // prompt sent during those waits shows here, and a turn is never cut off.
    const session = this.deps.session(candidate.id);
    if (!session || session.pid !== candidate.pid || session.tmux_target !== target) return;
    const refusal = restartRefusal({
      session,
      queued: this.deps.queued(target),
      idleSince: this.idleSince.get(session.id) ?? this.deps.now(),
      now: this.deps.now(),
      raw,
      running: this.deps.running(session),
      installed,
      restartedFor: restarted[session.id] ?? null,
      processes: rows && descendants(rows, session.pid),
      launch: this.deps.launch(session),
      ownsPane: panePid !== null && rows !== null && paneRunsProcess(rows, panePid, session.pid),
    });
    if (refusal) {
      console.log(`[claude-update] ${target} left alone: ${refusal}`);
      return;
    }

    // restartRefusal() has refused a null.
    const version = installed!;
    console.log(`[claude-update] restarting ${target} for ${version}`);
    // Written first: if the restart goes wrong partway, it is still not tried again.
    this.save((f) => {
      f.restarted[session.id] = version;
      for (const [id, earlier] of Object.entries(f.restarted)) {
        if (compareVersions(earlier, version) < 0) delete f.restarted[id];
      }
    });
    this.idleSince.delete(session.id);
    const outcome = await this.deps.restart(session);
    if (!outcome.ok) console.warn(`[claude-update] restart of ${target} failed: ${outcome.error}`);
  }
}

/** Start the updater once per process. The built server calls this; a dev server does not. */
export function startClaudeUpdater(): void {
  const g = globalThis as typeof globalThis & { __claudeMuxUpdater?: ClaudeUpdater };
  if (g.__claudeMuxUpdater) return;
  const updater = (g.__claudeMuxUpdater = new ClaudeUpdater());
  void updater.tick();
  setInterval(() => void updater.tick(), TICK_MS).unref?.();
}
