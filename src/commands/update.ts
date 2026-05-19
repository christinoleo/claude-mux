import { Command } from "commander";
import { execSync, spawnSync } from "child_process";
import { setTimeout as delay } from "timers/promises";
import { VERSION } from "../utils/version.js";
import { runSetup } from "../setup/index.js";
import { isPidAlive } from "../utils/pid.js";
import { DEFAULT_SERVER_PORT } from "../utils/paths.js";

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
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await delay(200);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function startProd(): void {
  console.log(`Starting prod server on 127.0.0.1:${DEFAULT_SERVER_PORT}...`);
  const result = spawnSync(
    "sh",
    [
      "-c",
      `nohup claude-mux serve --port ${DEFAULT_SERVER_PORT} --host 127.0.0.1 > /tmp/claude-mux-prod.log 2>&1 & disown`,
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

  // Stop the running prod server BEFORE `npm i -g` so the install doesn't
  // overwrite module files the live process is still loading lazily.
  const wasRunning = !opts.skipRestart ? findProdPid() : null;
  if (wasRunning) await stopProd(wasRunning);

  console.log(`\nInstalling claude-mux@${latest} globally via npm...`);
  const install = spawnSync("npm", ["i", "-g", `claude-mux@${latest}`], {
    stdio: "inherit",
  });
  if (install.status !== 0) {
    console.error("npm install failed.");
    if (wasRunning) {
      console.error("Old server was stopped; restart it manually with `claude-mux serve`.");
    }
    process.exit(install.status ?? 1);
  }

  console.log("\nRe-running setup to sync hooks...");
  await runSetup({ yes: true });

  if (wasRunning) {
    console.log("");
    startProd();
  } else if (!opts.skipRestart) {
    console.log("Prod server was not running; skipping restart.");
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
