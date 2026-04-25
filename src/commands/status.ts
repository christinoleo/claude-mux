import { Command } from "commander";
import { resolveSessionOrExit } from "./resolve-session.js";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Get current session state as JSON")
    .argument("<target>", "Session ID or tmux target")
    .action((target: string) => {
      const session = resolveSessionOrExit(target);

      process.stdout.write(
        JSON.stringify({
          id: session.id,
          state: session.state,
          current_action: session.current_action,
          tmux_target: session.tmux_target,
          cwd: session.cwd,
          pid: session.pid,
          git_root: session.git_root,
          last_update: session.last_update,
        }) + "\n"
      );
    });
}
