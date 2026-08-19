import { Command } from "commander";
import { execFileSync } from "child_process";
import { existsSync, statSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { upsertSession, writeLink } from "../db/sessions-json.js";
import { resolveSession } from "./resolve-session.js";
import { projectSlug } from "../utils/slug.js";

/** Pre-trust a workspace directory in ~/.claude.json so Claude skips the trust dialog */
function ensureWorkspaceTrusted(cwd: string) {
  const claudeJsonPath = join(homedir(), ".claude.json");
  try {
    const data = existsSync(claudeJsonPath)
      ? JSON.parse(readFileSync(claudeJsonPath, "utf-8"))
      : {};
    if (!data.projects) data.projects = {};
    if (!data.projects[cwd]) data.projects[cwd] = {};
    if (!data.projects[cwd].hasTrustDialogAccepted) {
      data.projects[cwd].hasTrustDialogAccepted = true;
      writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    process.stderr.write(
      JSON.stringify({ warning: "Failed to pre-trust workspace", detail: String(err) }) + "\n"
    );
  }
}

export function createNewSessionCommand(): Command {
  return new Command("new-session")
    .description("Spawn a new Claude Code session in a detached tmux session")
    .requiredOption("--cwd <path>", "Working directory for the new session")
    .option("--name <name>", "Custom session name (default: <project>-<timestamp>)")
    .option("--no-skip-permissions", "Don't add --dangerously-skip-permissions")
    .option("--linked-to <target>", "Link to an existing session (ID or tmux target)")
    .option("--resume <sessionId>", "Resume an existing Claude Code session (passes --resume to claude)")
    .action((options: { cwd: string; name?: string; skipPermissions: boolean; linkedTo?: string; resume?: string }) => {
      const cwd = options.cwd;

      if (!existsSync(cwd)) {
        process.stderr.write(
          JSON.stringify({ error: "Directory does not exist", cwd }) + "\n"
        );
        process.exit(2);
      }

      const stat = statSync(cwd);
      if (!stat.isDirectory()) {
        process.stderr.write(
          JSON.stringify({ error: "Path is not a directory", cwd }) + "\n"
        );
        process.exit(2);
      }

      const sessionName = options.name || `${projectSlug(cwd, "claude")}-${Date.now()}`;
      const claudeArgs = ["claude"];
      if (options.skipPermissions) {
        claudeArgs.push("--dangerously-skip-permissions");
      }
      if (options.resume) {
        claudeArgs.push("--resume", options.resume);
      }

      try {
        // Pre-trust the workspace so Claude skips the trust dialog
        ensureWorkspaceTrusted(cwd);

        // Use 'env -u CLAUDECODE' so Claude doesn't refuse to start
        // (tmux server's global env may have CLAUDECODE=1 from a parent session)
        const tmuxArgs = ["new-session", "-d", "-s", sessionName, "-c", cwd, "--", "env", "-u", "CLAUDECODE", ...claudeArgs];
        execFileSync("tmux", tmuxArgs, { stdio: "ignore" });

        // Detect actual base-index from tmux config
        const baseIndex = execFileSync("tmux", ["show-option", "-gv", "base-index"], {
          encoding: "utf-8",
        }).trim() || "0";
        const paneBaseIndex = execFileSync("tmux", ["show-option", "-gv", "pane-base-index"], {
          encoding: "utf-8",
        }).trim() || "0";
        const tmuxTarget = `${sessionName}:${baseIndex}.${paneBaseIndex}`;

        // Write link to separate file (survives hook overwrites)
        if (options.linkedTo) {
          const linked = resolveSession(options.linkedTo);
          const mainTarget = linked?.tmux_target || options.linkedTo;
          writeLink(tmuxTarget, mainTarget);
        }

        // Pre-register session so it appears in the dashboard
        const id = crypto.randomUUID();
        upsertSession({
          id,
          pid: 0,
          cwd,
          tmux_target: tmuxTarget,
          state: "idle",
        });

        process.stdout.write(
          JSON.stringify({
            ok: true,
            sessionName,
            tmuxTarget,
            id,
          }) + "\n"
        );
      } catch (err) {
        process.stderr.write(
          JSON.stringify({
            error: "Failed to create session",
            detail: err instanceof Error ? err.message : String(err),
          }) + "\n"
        );
        process.exit(2);
      }
    });
}
