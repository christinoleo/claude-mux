import { Command } from "commander";
import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { VERSION } from "../utils/version.js";
import { runSetup } from "../setup/index.js";
import { terminate } from "../utils/pid.js";
import { DEFAULT_SERVER_PORT } from "../utils/paths.js";

const UNIT_PATH = join(homedir(), ".config", "systemd", "user", "claude-mux.service");

// SSH non-login shells often lack XDG_RUNTIME_DIR, which `systemctl --user`
// needs to reach the user manager. Set it ourselves when missing.
function ensureXdgRuntime(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
}

function getLatestVersion(): string | null {
  try {
    const out = execSync("npm view claude-mux version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const SYSTEMD_UNIT = "claude-mux.service";

export interface PrefetchOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Pull the release tarball into npm's cache before anything is stopped. Right
 * after a publish the registry lists the new version minutes before it serves
 * the tarball, and an install in that gap 404s — which used to leave the host
 * with its server stopped. Retrying here waits the gap out while the old
 * server keeps running, and the install that follows reads from the cache.
 */
export async function prefetchRelease(version: string, opts: PrefetchOptions = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 15_000;
  for (let i = 1; i <= attempts; i++) {
    const r = spawnSync("npm", ["cache", "add", `claude-mux@${version}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (r.status === 0) return true;
    if (i === attempts) {
      process.stderr.write(r.stderr ?? "");
      return false;
    }
    if (i === 1) console.log(`claude-mux@${version} is not downloadable yet; waiting for npm to serve it...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function isSystemdManaged(): boolean {
  // Unit file present means `service install` was run on this host; that's
  // the authoritative signal. is-active can return false negatives under
  // SSH non-login where XDG_RUNTIME_DIR is unset.
  if (existsSync(UNIT_PATH)) return true;
  ensureXdgRuntime();
  const r = spawnSync("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return r.status === 0;
}

/**
 * Older unit files lack KillMode=process, so stopping the service also killed
 * the tmux server (and every Claude session) spawned from the dashboard.
 * Patch the unit in place and daemon-reload BEFORE we stop it.
 */
function ensureUnitKillMode(): void {
  if (!existsSync(UNIT_PATH)) return;
  try {
    const unit = readFileSync(UNIT_PATH, "utf-8");
    if (/^KillMode=/m.test(unit)) return;
    const patched = unit.replace(
      /^(RestartSec=.*)$/m,
      "$1\n# Only kill the server on stop/restart; tmux sessions started from the dashboard live on.\nKillMode=process"
    );
    if (patched === unit) return;
    writeFileSync(UNIT_PATH, patched, "utf-8");
    console.log("Patched systemd unit: KillMode=process (keeps tmux sessions alive across restarts)");
    systemctlUser("daemon-reload");
  } catch (err) {
    console.warn(`Could not patch unit file: ${String(err)}`);
  }
}

function systemctlUser(...args: string[]): number {
  ensureXdgRuntime();
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

function findProdPid(): number | null {
  try {
    const out = execSync(
      `lsof -t -i :${DEFAULT_SERVER_PORT} -sTCP:LISTEN 2>/dev/null || true`,
      { encoding: "utf-8" }
    ).trim();
    if (!out) return null;
    const pid = Number(out.split("\n")[0]);
    if (!pid) return null;
    const cmd = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();
    if (!cmd.includes("claude-mux") && !cmd.includes("cli.")) return null;
    return pid;
  } catch {
    return null;
  }
}

async function stopProd(pid: number): Promise<void> {
  console.log(`Stopping prod server (pid ${pid})...`);
  await terminate(pid);
}

function startProd(): void {
  console.log(`Starting prod server on 127.0.0.1:${DEFAULT_SERVER_PORT}...`);
  // POSIX-clean: with stdin/stdout/stderr redirected, `&` alone fully detaches.
  // `disown` is bash-only and breaks under /bin/sh = dash (Debian/Ubuntu).
  const result = spawnSync(
    "sh",
    [
      "-c",
      `nohup claude-mux serve --port ${DEFAULT_SERVER_PORT} --host 127.0.0.1 < /dev/null > /tmp/claude-mux-prod.log 2>&1 &`,
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    console.warn("Failed to relaunch prod server; start it manually.");
  } else {
    console.log("Prod server relaunched. Logs: /tmp/claude-mux-prod.log");
  }
}

export interface UpdateOptions {
  force?: boolean;
  skipRestart?: boolean;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  console.log(`Current version: ${VERSION}`);
  const latest = getLatestVersion();
  if (!latest) {
    console.error("Could not fetch latest version from npm. Check connectivity.");
    process.exit(1);
  }
  console.log(`Latest version:  ${latest}`);

  if (latest === VERSION && !opts.force) {
    console.log("Already on latest. Use --force to reinstall.");
    return;
  }

  if (!(await prefetchRelease(latest))) {
    console.error(`Could not download claude-mux@${latest} from npm; the running server was left alone.`);
    process.exit(1);
  }

  // Stop the running prod server BEFORE `npm i -g` so the install doesn't
  // overwrite module files the live process is still loading lazily.
  const skipRestart = !!opts.skipRestart;
  const systemdActive = !skipRestart && isSystemdManaged();
  const nohupPid = !skipRestart && !systemdActive ? findProdPid() : null;

  if (systemdActive) {
    ensureUnitKillMode();
    console.log(`Stopping ${SYSTEMD_UNIT} (systemd)...`);
    systemctlUser("stop", SYSTEMD_UNIT);
  } else if (nohupPid) {
    await stopProd(nohupPid);
  }

  console.log(`\nInstalling claude-mux@${latest} globally via npm...`);
  const install = spawnSync("npm", ["i", "-g", `claude-mux@${latest}`], {
    stdio: "inherit",
  });
  if (install.status !== 0) {
    console.error("npm install failed; starting the old server again.");
    if (systemdActive) systemctlUser("start", SYSTEMD_UNIT);
    else if (nohupPid) startProd();
    process.exit(install.status ?? 1);
  }

  console.log("\nRe-running setup to sync hooks...");
  // Through the binary npm just installed, not this process: the running code
  // is the old version, and a change to what setup writes (the hook command,
  // say) would otherwise only land on the update after the one that shipped it.
  const setup = spawnSync("claude-mux", ["setup", "--yes"], { stdio: "inherit" });
  if (setup.status !== 0) await runSetup({ yes: true });

  if (systemdActive) {
    console.log("");
    console.log(`Starting ${SYSTEMD_UNIT} (systemd)...`);
    systemctlUser("start", SYSTEMD_UNIT);
  } else if (nohupPid) {
    console.log("");
    startProd();
  } else if (!skipRestart) {
    console.log("No running server detected (neither systemd nor nohup); skipping restart.");
  }

  console.log("\nUpdate complete.");
}

export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update claude-mux to the latest version via npm and re-sync hooks")
    .option("--force", "Reinstall even if already on latest")
    .option("--skip-restart", "Do not restart prod server after update")
    .action(async (opts: UpdateOptions) => {
      await runUpdate(opts);
      process.exit(0);
    });
}
