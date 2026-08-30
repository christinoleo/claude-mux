import { Command } from "commander";
import { getSession, type SessionState } from "../db/sessions-json.js";
import { resolveSessionOrExit } from "./resolve-session.js";

const VALID_STATES: SessionState[] = ["idle", "busy", "waiting", "permission"];

export function createWaitIdleCommand(): Command {
  return new Command("wait")
    .description("Block until a session reaches a target state")
    .argument("<target>", "Session ID or tmux target")
    .option("--state <states>", "Comma-separated states to wait for", "idle,waiting,permission")
    .option("--timeout <seconds>", "Max wait time in seconds", "300")
    .option("--poll <ms>", "Poll interval in milliseconds", "500")
    .action(async (target: string, options: { state: string; timeout: string; poll: string }) => {
      const targetStates = options.state.split(",").map((s) => s.trim()) as SessionState[];
      for (const s of targetStates) {
        if (!VALID_STATES.includes(s)) {
          process.stderr.write(
            JSON.stringify({ error: `Invalid state: ${s}`, valid: VALID_STATES }) + "\n"
          );
          process.exit(2);
        }
      }

      const session = resolveSessionOrExit(target);
      const timeoutMs = Number(options.timeout) * 1000;
      const pollMs = Number(options.poll);
      const startTime = Date.now();
      let lastState = session.state;

      for (;;) {
        const current = getSession(session.id);
        if (!current) {
          process.stderr.write(
            JSON.stringify({ error: "Session disappeared", id: session.id }) + "\n"
          );
          process.exit(2);
        }

        // Report state transitions to stderr
        if (current.state !== lastState) {
          process.stderr.write(
            JSON.stringify({
              transition: true,
              from: lastState,
              to: current.state,
              elapsed_ms: Date.now() - startTime,
            }) + "\n"
          );
          lastState = current.state;
        }

        if (targetStates.includes(current.state)) {
          process.stdout.write(
            JSON.stringify({
              state: current.state,
              id: current.id,
              elapsed_ms: Date.now() - startTime,
            }) + "\n"
          );
          process.exit(0);
        }

        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          process.stderr.write(
            JSON.stringify({
              error: "Timeout",
              waiting_for: targetStates,
              state: current.state,
              elapsed_ms: elapsed,
            }) + "\n"
          );
          process.exit(1);
        }

        await sleep(pollMs);
      }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
