#!/usr/bin/env node

import { program } from "commander";
import { render } from "ink";
import React from "react";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { createInterface } from "readline";
import { App } from "./app.js";
import { runSetup, runUninstall } from "./setup/index.js";
import { closeDatabase } from "./db/index.js";
import { isInTmux, getTmuxSessionName } from "./tmux/detect.js";
import { DATABASE_PATH } from "./utils/paths.js";
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
  .option("--uninstall", "Remove claude-watch hooks and configuration")
  .action(async (options) => {
    if (options.setup) {
      await runSetup();
      process.exit(0);
    }

    if (options.uninstall) {
      await runUninstall();
      process.exit(0);
    }

    // Check if running in tmux
    if (!isInTmux()) {
      console.error("claude-watch requires tmux to run.");
      console.error("");
      console.error("Start tmux first, then run claude-watch:");
      console.error("  tmux new-session -s watch");
      console.error("  claude-watch");
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
          // Session doesn't exist, create it with claude-watch running
          execSync(`tmux new-session -d -s ${WATCH_SESSION} ${escapeArg(fullCmd)}`, { stdio: "inherit" });
          execSync(`tmux switch-client -t ${WATCH_SESSION}`, { stdio: "inherit" });
        }
      } catch (error) {
        console.error("Failed to switch to watch session:", error);
        process.exit(1);
      }

      process.exit(0);
    }

    // We're in the watch session, run the TUI

    // Check if setup has been run
    if (!existsSync(DATABASE_PATH)) {
      console.error("claude-watch has not been set up yet.");
      console.error("");
      console.error("Run the setup wizard first:");
      console.error("  claude-watch --setup");
      process.exit(1);
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

    // Rename current window to "watch"
    try {
      execSync(`tmux rename-window watch`, { stdio: "ignore" });
    } catch {
      // Ignore errors
    }

    // Add tmux keybinding dynamically (prefix + W to switch to watch session pane)
    try {
      execSync(`tmux bind-key W switch-client -t "${WATCH_SESSION}:1.1"`, { stdio: "ignore" });
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
      closeDatabase();
    }
  });

program.parse();
