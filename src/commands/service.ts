import { Command } from "commander";
import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { DEFAULT_SERVER_PORT } from "../utils/paths.js";

const SERVICE_NAME = "claude-mux.service";
const USER_UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(USER_UNIT_DIR, SERVICE_NAME);

function which(cmd: string): string | null {
  try {
    const out = execSync(`command -v ${cmd}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function hasSystemd(): boolean {
  return which("systemctl") !== null;
}

function buildUnit(port: number, host: string): string {
  const claudeMuxBin = which("claude-mux");
  if (!claudeMuxBin) {
    throw new Error("`claude-mux` not on PATH; install it first.");
  }
  const bunBin = which("bun");
  const extraPath = bunBin ? `${dirname(bunBin)}:` : "";

  return `[Unit]
Description=claude-mux serve (web dashboard + WebSocket)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=${extraPath}%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${claudeMuxBin} serve --port ${port} --host ${host}
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function systemctlUser(...args: string[]): number {
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

function lingerEnabled(): boolean {
  try {
    const user = process.env.USER ?? execSync("whoami", { encoding: "utf-8" }).trim();
    const out = execSync(`loginctl show-user ${user} -p Linger --value 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();
    return out === "yes";
  } catch {
    return false;
  }
}

interface InstallOptions {
  port?: string;
  host?: string;
  noStart?: boolean;
}

async function runInstall(opts: InstallOptions): Promise<void> {
  if (!hasSystemd()) {
    console.error("systemctl not found. This command requires systemd (Linux).");
    process.exit(1);
  }

  const port = Number(opts.port ?? DEFAULT_SERVER_PORT);
  const host = opts.host ?? "127.0.0.1";

  if (!existsSync(USER_UNIT_DIR)) mkdirSync(USER_UNIT_DIR, { recursive: true });
  const unit = buildUnit(port, host);
  writeFileSync(UNIT_PATH, unit, "utf-8");
  console.log(`Wrote ${UNIT_PATH}`);

  if (systemctlUser("daemon-reload") !== 0) {
    console.error("systemctl --user daemon-reload failed.");
    process.exit(1);
  }

  const cmd = opts.noStart ? ["enable"] : ["enable", "--now"];
  if (systemctlUser(...cmd, SERVICE_NAME) !== 0) {
    console.error("Failed to enable service.");
    process.exit(1);
  }

  console.log(`\nService installed. Listening on ${host}:${port}.`);
  console.log("Logs: journalctl --user -u claude-mux.service -f");
  console.log("Status: systemctl --user status claude-mux.service");

  if (!lingerEnabled()) {
    const user = process.env.USER ?? "$USER";
    console.log("");
    console.log("⚠  Linger is OFF — service stops when you log out and does NOT start on boot.");
    console.log("   To survive reboot/logout, run ONCE (requires sudo):");
    console.log(`     sudo loginctl enable-linger ${user}`);
  }
}

interface UninstallOptions {
  purge?: boolean;
}

async function runUninstall(opts: UninstallOptions): Promise<void> {
  if (!hasSystemd()) {
    console.error("systemctl not found.");
    process.exit(1);
  }

  if (existsSync(UNIT_PATH)) {
    systemctlUser("disable", "--now", SERVICE_NAME);
    if (opts.purge) {
      unlinkSync(UNIT_PATH);
      console.log(`Removed ${UNIT_PATH}`);
      systemctlUser("daemon-reload");
    } else {
      console.log(`Disabled ${SERVICE_NAME}. Unit file kept at ${UNIT_PATH} (use --purge to remove).`);
    }
  } else {
    console.log(`No unit file at ${UNIT_PATH}; nothing to uninstall.`);
  }
}

async function runStatus(): Promise<void> {
  if (!hasSystemd()) {
    console.error("systemctl not found.");
    process.exit(1);
  }
  systemctlUser("status", SERVICE_NAME, "--no-pager");
}

export function createServiceCommand(): Command {
  const svc = new Command("service").description("Manage claude-mux as a systemd user service");

  svc
    .command("install")
    .description("Install systemd user unit and enable it (does not require sudo)")
    .option("--port <number>", "Listen port", String(DEFAULT_SERVER_PORT))
    .option("--host <address>", "Listen host", "127.0.0.1")
    .option("--no-start", "Enable for boot but do not start now")
    .action(async (opts: InstallOptions) => {
      await runInstall(opts);
      process.exit(0);
    });

  svc
    .command("uninstall")
    .description("Disable the systemd user service")
    .option("--purge", "Also remove the unit file")
    .action(async (opts: UninstallOptions) => {
      await runUninstall(opts);
      process.exit(0);
    });

  svc
    .command("status")
    .description("Show systemd service status")
    .action(async () => {
      await runStatus();
      process.exit(0);
    });

  return svc;
}
