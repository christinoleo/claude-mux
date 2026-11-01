import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeUpdater,
  compareVersions,
  decideInstall,
  detectInstaller,
  launchCarriesPrompt,
  paneRunsProcess,
  processVersion,
  readClaudeUpdateStatus,
  restartRefusal,
  ATTEMPT_GAP_MS,
  IDLE_BEFORE_RESTART_MS,
  PUBLISH_WAIT_MS,
  type Exec,
  type RestartFacts,
  type UpdaterDeps,
} from "../../src/server/claude-update.js";
import type { Session } from "../../src/db/sessions-json.js";

const NOW = 1_800_000_000_000;
const RULE = "─".repeat(80);
const DAY = PUBLISH_WAIT_MS;

/** A pane at rest: box, footer, the notice. */
function pane(box = "❯ ", notice = "✔ Update installed · /restart to apply"): string {
  return ["● Done.", "", RULE, box, RULE, `  ? for shortcuts        ${notice}`].join("\n");
}

describe("decideInstall", () => {
  const base = { installed: "2.1.300", firstSeen: {}, attempts: {}, now: NOW };

  it("does nothing when no release is newer", () => {
    expect(decideInstall({ ...base, releases: [{ version: "2.1.300", publishedAt: NOW - 9 * DAY }] })).toEqual({ state: "current", target: null });
  });

  it("waits until a version has been published for 24 hours", () => {
    const publishedAt = NOW - DAY + 1000;
    expect(decideInstall({ ...base, releases: [{ version: "2.1.301", publishedAt }] })).toEqual({
      state: "waiting",
      target: "2.1.301",
      at: publishedAt + DAY,
    });
    expect(decideInstall({ ...base, releases: [{ version: "2.1.301", publishedAt: NOW - DAY }] })).toEqual({
      state: "installing",
      target: "2.1.301",
    });
  });

  it("takes the newest release old enough, so a daily release cannot starve it", () => {
    const releases = [
      { version: "2.1.303", publishedAt: NOW - 1000 },
      { version: "2.1.302", publishedAt: NOW - DAY - 1000 },
      { version: "2.1.301", publishedAt: NOW - 3 * DAY },
    ];
    expect(decideInstall({ ...base, releases })).toEqual({ state: "installing", target: "2.1.302" });
  });

  it("counts from when this machine first saw a version with no date", () => {
    const releases = [{ version: "2.1.301", publishedAt: null }];
    expect(decideInstall({ ...base, releases }).state).toBe("waiting");
    expect(decideInstall({ ...base, releases, firstSeen: { "2.1.301": NOW - DAY + 1 } }).state).toBe("waiting");
    expect(decideInstall({ ...base, releases, firstSeen: { "2.1.301": NOW - DAY } })).toEqual({ state: "installing", target: "2.1.301" });
  });

  it("keeps counting a version the installer has moved past, so a cask is not starved", () => {
    const firstSeen = { "2.1.301": NOW - DAY, "2.1.302": NOW - 1000 };
    expect(decideInstall({ ...base, releases: [{ version: "2.1.302", publishedAt: null }], firstSeen })).toEqual({
      state: "installing",
      target: "2.1.301",
    });
  });

  const old = (version: string) => ({ version, publishedAt: NOW - 2 * DAY });

  it("tries again only an hour after an attempt", () => {
    const attempts = { "2.1.301": { count: 1, lastAt: NOW - ATTEMPT_GAP_MS + 1 } };
    expect(decideInstall({ ...base, releases: [old("2.1.301")], attempts }).state).toBe("retrying");
    const later = { "2.1.301": { count: 1, lastAt: NOW - ATTEMPT_GAP_MS } };
    expect(decideInstall({ ...base, releases: [old("2.1.301")], attempts: later }).state).toBe("installing");
  });

  it("stops after 2 attempts, however long ago, and a newer version clears the stop", () => {
    const attempts = { "2.1.301": { count: 2, lastAt: NOW - 30 * DAY } };
    expect(decideInstall({ ...base, releases: [old("2.1.301")], attempts })).toEqual({ state: "failed", target: "2.1.301" });
    expect(decideInstall({ ...base, releases: [old("2.1.301"), old("2.1.302")], attempts })).toEqual({
      state: "installing",
      target: "2.1.302",
    });
  });
});

describe("compareVersions", () => {
  it("compares numerically", () => {
    expect(compareVersions("2.1.99", "2.1.100")).toBeLessThan(0);
    expect(compareVersions("2.2.0", "2.1.100")).toBeGreaterThan(0);
    expect(compareVersions("2.1.3", "2.1.3")).toBe(0);
  });
});

describe("detectInstaller", () => {
  const at = (found: string, real = found) => detectInstaller({ found, real });
  const home = "/home/u";

  const MISE = ["mise", ["install", "claude@2.1.316"]];
  it.each([
    ["mise", `${home}/.local/share/mise/installs/claude/latest/claude`, `${home}/.local/share/mise/installs/claude/2.1.309/claude`, MISE],
    ["mise under its own data dir", "/x/mise/data/installs/claude/latest/claude", undefined, MISE],
    ["a mise shim", `${home}/.local/share/mise/shims/claude`, "/usr/bin/mise", MISE],
    ["npm", "/usr/bin/claude", "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", ["npm", ["i", "-g", "@anthropic-ai/claude-code@2.1.316"]]],
    ["brew", "/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.309/claude", ["brew", ["upgrade", "--cask", "claude-code"]]],
  ] as const)("recognises %s", (_name, found, real, argv) => {
    const installer = at(found, real);
    expect(installer !== "self" && installer?.install("2.1.316")).toEqual(argv);
  });

  it("leaves a native installation to update itself", () => {
    expect(at(`${home}/.local/bin/claude`, `${home}/.local/share/claude/versions/2.1.309`)).toBe("self");
  });

  it("runs nothing for a binary it cannot place", () => {
    expect(at("/u/.bun/install/global/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBeNull();
    expect(at("/u/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js")).toBeNull();
    expect(at("/opt/odd/claude")).toBeNull();
    expect(detectInstaller(null)).toBeNull();
  });

  it("reads mise's dates, and npm's up to the latest tag", async () => {
    const run = vi.fn<Exec>(async (command) => ({
      ok: true,
      stderr: "",
      stdout:
        command === "mise"
          ? JSON.stringify([{ version: "2.1.1", created_at: "2026-10-31T01:01:35.0Z" }, { version: "2.1.2" }, { version: "nightly" }])
          : JSON.stringify({
              "dist-tags": { latest: "2.1.2" },
              time: { created: "2020-01-01T00:00:00Z", "2.1.2": "2026-10-31T00:00:00Z", "2.1.3": "2026-11-01T00:00:00Z", "2.1.2-rc": "2026-10-30T00:00:00Z" },
            }),
    }));
    const mise = at("/x/mise/installs/claude/latest/claude");
    expect(mise !== "self" && (await mise?.releases(run, ""))).toEqual([
      { version: "2.1.1", publishedAt: Date.parse("2026-10-31T01:01:35.0Z") },
      { version: "2.1.2", publishedAt: null },
    ]);
    const npm = at("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js");
    expect(npm !== "self" && (await npm?.releases(run, ""))).toEqual([{ version: "2.1.2", publishedAt: Date.parse("2026-10-31T00:00:00Z") }]);
  });
});

describe("launchCarriesPrompt", () => {
  it("passes flags and their values", () => {
    expect(launchCarriesPrompt(["claude"])).toBe(false);
    expect(launchCarriesPrompt(["claude", "--model", "opus", "--dangerously-skip-permissions"])).toBe(false);
    expect(launchCarriesPrompt(["claude", "--model=opus"])).toBe(false);
  });

  it("finds a prompt, as a maestro worker is started with", () => {
    expect(launchCarriesPrompt(["claude", "--model", "opus", "--dangerously-skip-permissions", "/ak:maestro-worker 174"])).toBe(true);
    expect(launchCarriesPrompt(["claude", "--model", "opus", "/ak:maestro-worker", "174"])).toBe(true);
  });

  it("does not read a node launch's script as a prompt", () => {
    expect(launchCarriesPrompt(["node", "/x/cli.js", "--model", "opus"])).toBe(false);
    expect(launchCarriesPrompt(["node", "/x/cli.js", "fix it"])).toBe(true);
  });

  it("refuses a flag it does not know the value of", () => {
    expect(launchCarriesPrompt(["claude", "--session-id", "abc"])).toBe(true);
  });
});

describe("processVersion", () => {
  it("reads what Claude Code recorded for the process, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-mux-procs-"));
    process.env.CLAUDE_SESSIONS_DIR = dir;
    try {
      writeFileSync(join(dir, "11.json"), JSON.stringify({ pid: 11, version: "2.1.309" }));
      writeFileSync(join(dir, "12.json"), JSON.stringify({ pid: 12 }));
      expect(processVersion(11)).toBe("2.1.309");
      expect(processVersion(12)).toBeNull();
      expect(processVersion(13)).toBeNull();
    } finally {
      delete process.env.CLAUDE_SESSIONS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paneRunsProcess", () => {
  const rows = [
    { pid: 10, ppid: 1, args: "-bash" },
    { pid: 11, ppid: 10, args: "claude --model opus" },
    { pid: 12, ppid: 11, args: "/usr/bin/bash -c eval" },
    { pid: 13, ppid: 12, args: "/x/claude --print" },
    { pid: 20, ppid: 1, args: "-bash" },
  ];
  it("accepts the pane's command and a process under its shell", () => {
    expect(paneRunsProcess(rows, 11, 11)).toBe(true);
    expect(paneRunsProcess(rows, 10, 11)).toBe(true);
  });
  it("refuses another pane, and a Claude Code nested in one", () => {
    expect(paneRunsProcess(rows, 20, 11)).toBe(false);
    expect(paneRunsProcess(rows, 10, 13)).toBe(false);
  });
});

describe("restartRefusal", () => {
  const eligible: RestartFacts = {
    session: { state: "idle", last_update: NOW - IDLE_BEFORE_RESTART_MS, background_tasks: 0 },
    queued: 0,
    idleSince: NOW - IDLE_BEFORE_RESTART_MS,
    now: NOW,
    raw: pane(),
    running: "2.1.300",
    installed: "2.1.301",
    restartedFor: null,
    processes: [{ pid: 2, ppid: 1, args: "chrome-devtools-mcp" }],
    launch: ["claude", "--dangerously-skip-permissions"],
    ownsPane: true,
  };

  it("allows a session that meets every condition", () => {
    expect(restartRefusal(eligible)).toBeNull();
    expect(restartRefusal({ ...eligible, raw: pane("❯ ", "Update available! Run: mise upgrade claude") })).toBeNull();
  });

  const refusals: [string, Partial<RestartFacts>, string][] = [
    ["a busy session", { session: { ...eligible.session, state: "busy" } }, "not idle"],
    ["a waiting session", { session: { ...eligible.session, state: "waiting" } }, "not idle"],
    ["a permission dialog", { session: { ...eligible.session, state: "permission" } }, "not idle"],
    ["a recent hook event", { session: { ...eligible.session, last_update: NOW - IDLE_BEFORE_RESTART_MS + 1 } }, "idle for under 10 minutes"],
    ["idle only just seen", { idleSince: NOW - IDLE_BEFORE_RESTART_MS + 1 }, "idle for under 10 minutes"],
    ["a pane it cannot read", { raw: null }, "pane unreadable"],
    ["no notice", { raw: ["● Done.", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n") }, "no update notice"],
    ["a failed auto-update notice", { raw: pane("❯ ", "✗ Auto-update failed · Try claude doctor") }, "no update notice"],
    ["a draft in the box", { raw: pane("❯ half a thought") }, "pane holds: typed"],
    ["a dialog a local command drew", { raw: [" Select model", " ❯ 1. Default", "   2. Sonnet", "", " Enter to confirm · Esc to exit"].join("\n") }, "dialog open"],
    ["a screen with no box", { raw: ["● Done.", "  ? for shortcuts        ✔ Update installed · /restart to apply"].join("\n") }, "prompt box not clear"],
    ["a draft the box reader bails on", { raw: pane("❯ 1. fix the tests") }, "prompt box not clear"],
    ["shell mode in the box", { raw: pane("! ls") }, "prompt box not clear"],
    ["messages claude-mux holds", { queued: 1 }, "messages queued"],
    ["a running subagent", { session: { ...eligible.session, subagents: [{ id: "a" }] as never } }, "background tasks"],
    ["Remote Control on", { session: { ...eligible.session, rc_url: "https://claude.ai/code/x" } }, "Remote Control on"],
    ["a counted background task", { session: { ...eligible.session, background_tasks: 1 } }, "background tasks"],
    ["a running background shell", { processes: [{ pid: 3, ppid: 1, args: "/usr/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'bun run dev'" }] }, "background shell running"],
    ["a process table it cannot read", { processes: null }, "process table unreadable"],
    ["a stale record of another pane", { ownsPane: false }, "process is not in that pane"],
    ["an unreadable launch", { launch: null }, "launch unreadable"],
    ["a launch with a prompt", { launch: ["claude", "/ak:maestro-worker 174"] }, "launch carries a prompt"],
    ["no version from the transcript", { running: null }, "version unknown"],
    ["no installed version", { installed: null }, "version unknown"],
    ["a session already on the version", { running: "2.1.301" }, "already on the installed version"],
    ["the one restart already spent", { restartedFor: "2.1.301" }, "already restarted for this version"],
  ];
  it.each(refusals)("refuses %s", (_name, change, reason) => {
    expect(restartRefusal({ ...eligible, ...change })).toBe(reason);
  });

  it("restarts for a newer version even after one for an older", () => {
    expect(restartRefusal({ ...eligible, restartedFor: "2.1.300" })).toBeNull();
  });
});

describe("ClaudeUpdater", () => {
  let dir: string;
  let now: number;
  /** What `claude --version` answers; an install moves it when `takes` says so. */
  let version: string;
  let takes: boolean;
  /** What the installer lists, each published two days ago. */
  let remote: string[];
  let installs: string[];
  let restarts: string[];
  let sessionList: Session[];

  const session = (over: Partial<Session> = {}): Session =>
    ({
      id: "s1",
      pid: process.pid,
      cwd: "/",
      tmux_target: "t:1.0",
      state: "idle",
      last_update: NOW - IDLE_BEFORE_RESTART_MS,
      ...over,
    }) as Session;

  const exec: Exec = async (command, args) => {
    if (command === "claude") return { ok: true, stdout: `${version} (Claude Code)\n`, stderr: "" };
    if (command === "mise" && args[0] === "ls-remote") {
      const created_at = new Date(NOW - 2 * DAY).toISOString();
      return { ok: true, stderr: "", stdout: JSON.stringify(remote.map((v) => ({ version: v, created_at }))) };
    }
    installs.push(args.join(" "));
    if (takes) version = "2.1.301";
    // Exit 0 on purpose: only the version reported decides.
    return { ok: true, stdout: "installed\n", stderr: "" };
  };

  const updater = (over: Partial<UpdaterDeps> = {}) =>
    new ClaudeUpdater({
      statePath: join(dir, "claude-update.json"),
      lockPath: join(dir, "claude-update.lock"),
      now: () => now,
      enabled: () => true,
      sessions: () => sessionList,
      session: (id) => sessionList.find((s) => s.id === id) ?? null,
      pathOf: () => "/fake",
      locate: () => ({ found: "/x/mise/installs/claude/latest/claude", real: "/x/mise/installs/claude/2.1.300/claude" }),
      exec,
      capture: async () => pane(),
      processTable: async () => [{ pid: process.pid, ppid: 1, args: "claude" }],
      panePid: async () => process.pid,
      running: () => "2.1.300",
      queued: () => 0,
      launch: () => ["claude", "--dangerously-skip-permissions"],
      restart: async (s) => {
        restarts.push(s.id);
        return { ok: true, command: "claude" };
      },
      ...over,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-mux-update-"));
    now = NOW;
    version = "2.1.300";
    takes = true;
    remote = ["2.1.301"];
    installs = [];
    restarts = [];
    sessionList = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const status = () => readClaudeUpdateStatus(join(dir, "claude-update.json"));

  it("installs once per machine, and judges success by the version reported", async () => {
    await updater().checkInstall();
    expect(installs).toEqual(["install claude@2.1.301"]);
    expect(status()).toMatchObject({ state: "current", installed: "2.1.301" });
    await updater().checkInstall();
    expect(installs).toHaveLength(1);
  });

  it("does not believe an install that exited 0 and changed nothing", async () => {
    takes = false;
    await updater().checkInstall();
    expect(status()).toMatchObject({ state: "retrying", installed: "2.1.300", target: "2.1.301" });
  });

  it("keeps its count across a restart of claude-mux, and stops at 2", async () => {
    takes = false;
    await updater().checkInstall();
    // A new updater is a restarted server: nothing but the file carries over.
    await updater().checkInstall();
    expect(installs).toHaveLength(1);
    now += ATTEMPT_GAP_MS;
    await updater().checkInstall();
    expect(installs).toHaveLength(2);
    expect(status()).toMatchObject({ state: "failed", target: "2.1.301", output: "installed" });
    now += 30 * DAY;
    await updater().checkInstall();
    expect(installs).toHaveLength(2);
    expect(status()?.state).toBe("failed");
  });

  it("counts an attempt that dies mid-install", async () => {
    takes = false;
    const crash: Exec = async (command, args, options) => {
      if (args[0] === "install") throw new Error("server went down");
      return exec(command, args, options);
    };
    await expect(updater({ exec: crash }).checkInstall()).rejects.toThrow();
    await updater().checkInstall();
    expect(installs).toHaveLength(0);
    expect(status()?.state).toBe("retrying");
  });

  it("clears the stop when a newer version is due", async () => {
    takes = false;
    await updater().checkInstall();
    now += ATTEMPT_GAP_MS;
    await updater().checkInstall();
    expect(status()?.state).toBe("failed");
    remote = ["2.1.301", "2.1.302"];
    await updater().checkInstall();
    expect(installs.at(-1)).toBe("install claude@2.1.302");
  });

  it("runs no install on an installation that updates itself", async () => {
    await updater({ locate: () => ({ found: "/u/.local/bin/claude", real: "/u/.local/share/claude/versions/2.1.300" }) }).checkInstall();
    expect(installs).toEqual([]);
    expect(status()?.state).toBe("self-updating");
  });

  it("restarts an eligible session once per version, across a restart of claude-mux", async () => {
    version = "2.1.301";
    sessionList = [session()];
    const first = updater();
    now += IDLE_BEFORE_RESTART_MS;
    await first.restartEligible(); // first sight of idle starts its clock
    expect(restarts).toEqual([]);
    now += IDLE_BEFORE_RESTART_MS;
    await first.restartEligible();
    expect(restarts).toEqual(["s1"]);

    // It came back still showing the notice, and writing the old version.
    const second = updater();
    await second.restartEligible();
    now += IDLE_BEFORE_RESTART_MS;
    await second.restartEligible();
    expect(restarts).toEqual(["s1"]);
  });

  it("leaves busy and drafting sessions alone while restarting the eligible one", async () => {
    version = "2.1.301";
    sessionList = [
      session({ id: "idle", tmux_target: "t:1.0" }),
      session({ id: "busy", tmux_target: "t:2.0", state: "busy" }),
      session({ id: "draft", tmux_target: "t:3.0" }),
    ];
    const u = updater({ capture: async (target) => (target === "t:3.0" ? pane("❯ half a thought") : pane()) });
    await u.restartEligible();
    now += IDLE_BEFORE_RESTART_MS;
    await u.restartEligible();
    expect(restarts).toEqual(["idle"]);
  });

  it("leaves a record with no process alone, though pid 0 reads as alive", async () => {
    version = "2.1.301";
    sessionList = [session({ pid: 0 })];
    const u = updater({ processTable: async () => [], panePid: async () => 0 });
    await u.restartEligible();
    now += IDLE_BEFORE_RESTART_MS;
    await u.restartEligible();
    expect(restarts).toEqual([]);
  });

  it("forgets its idle clock when a session works", async () => {
    version = "2.1.301";
    sessionList = [session()];
    const u = updater();
    await u.restartEligible();
    sessionList = [session({ state: "busy" })];
    await u.restartEligible();
    now += IDLE_BEFORE_RESTART_MS;
    sessionList = [session()];
    await u.restartEligible();
    expect(restarts).toEqual([]);
  });

  it("does nothing while switched off", async () => {
    sessionList = [session()];
    const u = updater({ enabled: () => false });
    await u.tick();
    now += IDLE_BEFORE_RESTART_MS;
    await u.tick();
    expect(installs).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("stands aside for another live server on the machine", async () => {
    const lockPath = join(dir, "other.lock");
    writeFileSync(lockPath, String(process.ppid));
    await updater({ lockPath }).tick();
    expect(installs).toEqual([]);
  });
});
