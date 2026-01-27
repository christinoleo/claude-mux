#!/usr/bin/env node

import { program } from "commander";
import { render } from "ink";
import React from "react";
import { execSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from "fs";
import { createInterface } from "readline";
import { App } from "./app.js";
import { runSetup, runCleanup } from "./setup/index.js";
import { isInTmux, getTmuxSessionName } from "./tmux/detect.js";
import { join } from "path";
import { CLAUDE_WATCH_DIR, SESSIONS_DIR } from "./utils/paths.js";
import { isPidAlive } from "./utils/pid.js";
import { VERSION } from "./utils/version.js";
import {
  checkHooksStatus,
  getInstalledHooksVersion,
  installHooks,
  saveClaudeSettings,
} from "./setup/hooks.js";

/**
 * Prompt user for input and return their response.
 */
function promptUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

program
  .name("claude-watch")
  .description("TUI dashboard for monitoring Claude Code sessions")
  .version(VERSION);

const WATCH_SESSION = "watch";

program
  .option("--setup", "Run interactive setup wizard")
  .option("--cleanup", "Remove claude-watch hooks from Claude Code settings")
  .action(async (options) => {
    if (options.setup) {
      await runSetup();
      process.exit(0);
    }

    if (options.cleanup) {
      await runCleanup();
      process.exit(0);
    }

    // Check if running in tmux
    if (!isInTmux()) {
      console.error("claude-watch requires tmux to run.");
      console.error("");
      console.error("Start tmux first, then run claude-watch from inside tmux.");
      process.exit(1);
    }

    // Check if we're in the correct session
    const currentSession = getTmuxSessionName();
    if (currentSession !== WATCH_SESSION) {
      console.log(`Switching to '${WATCH_SESSION}' session...`);

      // Build command to re-invoke claude-watch the same way it was originally called
      const cwd = process.cwd();
      // Escape single quotes in args for shell safety
      const escapeArg = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;
      const originalCmd = process.argv.map(escapeArg).join(" ");
      const fullCmd = `cd ${escapeArg(cwd)} && ${originalCmd}`;

      try {
        // Check if watch session exists
        let sessionExists = false;
        try {
          execSync(`tmux has-session -t ${WATCH_SESSION} 2>/dev/null`, { stdio: "ignore" });
          sessionExists = true;
        } catch {
          sessionExists = false;
        }

        if (sessionExists) {
          // Check if claude-watch is running in the session
          let claudeWatchRunning = false;
          try {
            const paneCmd = execSync(
              `tmux list-panes -t ${WATCH_SESSION} -F "#{pane_current_command}"`,
              { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
            ).trim();
            // Check if node or claude-watch is running (our process)
            claudeWatchRunning = paneCmd.includes("node") || paneCmd.includes("claude-watch");
          } catch {
            claudeWatchRunning = false;
          }

          if (!claudeWatchRunning) {
            // claude-watch not running, start it in the existing session
            execSync(`tmux send-keys -t ${WATCH_SESSION} ${escapeArg(fullCmd)} Enter`, { stdio: "inherit" });
          }

          // Switch to the session
          execSync(`tmux switch-client -t ${WATCH_SESSION}`, { stdio: "inherit" });
        } else {
          // Session doesn't exist, create it with claude-watch running.
          //
          // NOTE: We pass the command directly to new-session rather than
          // creating an empty session and using send-keys. The send-keys
          // approach caused a race condition on macOS where zsh's compinit
          // prompt would intercept keystrokes before the shell was ready,
          // mangling the command (e.g. "cd" becoming "d"). Passing the
          // command to new-session avoids the interactive shell init entirely.
          //
          // If this causes issues on other platforms (e.g. WSL/Ubuntu where
          // send-keys was previously used), the alternative is:
          //   execSync(`tmux new-session -d -s ${WATCH_SESSION}`, { stdio: "ignore" });
          //   execSync(`tmux send-keys -t ${WATCH_SESSION} ${escapeArg(fullCmd)} Enter`, { stdio: "ignore" });
          // but that requires a delay or readiness check to avoid the macOS race.
          execSync(`tmux new-session -d -s ${WATCH_SESSION} ${escapeArg(fullCmd)}`, { stdio: "ignore" });
          execSync(`tmux switch-client -t ${WATCH_SESSION}`, { stdio: "inherit" });
        }
      } catch (error) {
        console.error("Failed to switch to watch session:", error);
        process.exit(1);
      }

      process.exit(0);
    }

    // We're in the watch session, run the TUI

    // Auto-create data directories if needed
    if (!existsSync(CLAUDE_WATCH_DIR)) {
      mkdirSync(CLAUDE_WATCH_DIR, { recursive: true });
    }
    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    // Check hooks version and prompt if needed
    const hooksStatus = checkHooksStatus();
    if (hooksStatus !== "current") {
      const installedVersion = getInstalledHooksVersion();
      const action = hooksStatus === "install" ? "installed" : "updated";
      const currentInfo = installedVersion ? `installed: ${installedVersion}` : "not installed";

      console.log(`claude-watch hooks need to be ${action} (${currentInfo}, required: ${VERSION})`);
      console.log("");

      const answer = await promptUser(`${hooksStatus === "install" ? "Install" : "Update"} hooks now? [Y/n/q]: `);
      const normalized = answer.toLowerCase().trim();

      if (normalized === "q") {
        console.log("Exiting.");
        process.exit(0);
      } else if (normalized === "n") {
        console.log("Skipping hook installation. Some features may not work correctly.");
        console.log("");
      } else {
        // Default to Yes
        console.log("Installing hooks...");
        const { newSettings } = installHooks();
        saveClaudeSettings(newSettings);
        console.log("Hooks installed successfully.");
        console.log("");
      }
    }

    // Check if another instance is already running
    const lockFile = join(CLAUDE_WATCH_DIR, "claude-watch.lock");
    if (existsSync(lockFile)) {
      try {
        const lock = JSON.parse(readFileSync(lockFile, "utf-8"));
        if (lock.pid && isPidAlive(lock.pid)) {
          console.log("claude-watch is already running.");
          if (lock.tmux_target) {
            try {
              execSync(`tmux switch-client -t "${lock.tmux_target}"`, { stdio: "inherit" });
            } catch {
              // Ignore - may already be in the right pane
            }
          }
          process.exit(0);
        }
      } catch {
        // Stale or corrupt lock file, proceed
      }
    }

    // Write lock file
    const tmuxTarget = `${WATCH_SESSION}:${(() => {
      try {
        return execSync('tmux display-message -p "#{window_index}.#{pane_index}"', {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return "1.1";
      }
    })()}`;
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, tmux_target: tmuxTarget }));

    // Rename current window to "watch"
    try {
      execSync(`tmux rename-window watch`, { stdio: "ignore" });
    } catch {
      // Ignore errors
    }

    // Add tmux keybinding dynamically (prefix + W to switch to watch session pane)
    try {
      execSync(`tmux bind-key W switch-client -t "${tmuxTarget}"`, { stdio: "ignore" });
    } catch {
      // Ignore errors - binding might already exist
    }

    // Enter alternate screen buffer (like vim, htop)
    process.stdout.write("\x1b[?1049h");
    process.stdout.write("\x1b[H"); // Move cursor to top-left

    const { waitUntilExit } = render(React.createElement(App));

    try {
      await waitUntilExit();
    } finally {
      // Exit alternate screen buffer, restore previous content
      process.stdout.write("\x1b[?1049l");
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    }
  });

program.parse();
