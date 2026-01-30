import { createInterface } from "readline";
import { mkdirSync, existsSync } from "fs";
import { CLAUDE_WATCH_DIR, SESSIONS_DIR } from "../utils/paths.js";
import { installHooks, saveClaudeSettings, uninstallHooks } from "./hooks.js";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N] `);
  return answer === "y" || answer === "yes";
}

export async function runSetup(): Promise<void> {
  console.log("\n claude-mux Setup\n");

  // Step 1: Create data directories
  console.log("Step 1: Creating data directories...");
  if (!existsSync(CLAUDE_WATCH_DIR)) {
    mkdirSync(CLAUDE_WATCH_DIR, { recursive: true });
    console.log(`  Created ${CLAUDE_WATCH_DIR}`);
  } else {
    console.log(`  ${CLAUDE_WATCH_DIR} already exists`);
  }
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`  Created ${SESSIONS_DIR}`);
  } else {
    console.log(`  ${SESSIONS_DIR} already exists`);
  }

  // Step 2: Configure Claude hooks
  console.log("\nStep 2: Configuring Claude Code hooks...");
  const { diff, newSettings } = installHooks();
  console.log("");
  console.log(diff);
  console.log("");

  const confirmHooks = await confirm("Apply these changes to Claude settings?");
  if (confirmHooks) {
    saveClaudeSettings(newSettings);
    console.log("  Hooks installed successfully");
  } else {
    console.log("  Skipped hook installation");
  }

  // Done
  console.log("\n Setup complete!\n");
  console.log("To start claude-mux, run from any tmux session:");
  console.log("  claude-mux");
  console.log("");
  console.log("This will automatically create a 'watch' session and add");
  console.log("a keybinding (prefix + W) to quickly return to the dashboard.");
  console.log("");
}

export async function runCleanup(): Promise<void> {
  console.log("\n claude-mux Cleanup\n");

  console.log("Removing Claude Code hooks...");
  uninstallHooks();
  console.log("  Hooks removed successfully");

  console.log("\nData directory: " + CLAUDE_WATCH_DIR);
  console.log("  (Manual removal: rm -rf ~/.claude-mux)");

  console.log("\n Cleanup complete!\n");
}

export { installHooks, uninstallHooks } from "./hooks.js";
