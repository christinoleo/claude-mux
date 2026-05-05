import { Command } from "commander";
import { runSetup } from "../setup/index.js";

export function createSetupCommand(): Command {
  return new Command("setup")
    .description("Run interactive setup wizard")
    .option("-y, --yes", "Auto-confirm all prompts (non-interactive)")
    .action(async (opts: { yes?: boolean }) => {
      await runSetup({ yes: opts.yes });
      process.exit(0);
    });
}
