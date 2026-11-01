import { Command } from "commander";
import { execFileSync } from "child_process";
import { resolveSessionOrExit } from "./resolve-session.js";
import { capturePaneContentAsync, isDialogOpen } from "../tmux/pane.js";

export function createSendCommand(): Command {
  return new Command("send")
    .description("Send prompt text or raw keys to a session's tmux pane")
    .argument("<target>", "Session ID or tmux target")
    .argument("[text]", "Prompt text to send")
    .option("--keys <keys>", "Send raw tmux keys instead of text")
    .action(async (target: string, text: string | undefined, options: { keys?: string }) => {
      const session = resolveSessionOrExit(target);
      const tmuxTarget = session.tmux_target;

      if (!tmuxTarget) {
        process.stderr.write(
          JSON.stringify({ error: "Session has no tmux target", id: session.id }) + "\n"
        );
        process.exit(2);
      }

      try {
        if (options.keys) {
          // Raw keys mode
          execFileSync("tmux", ["send-keys", "-t", tmuxTarget, options.keys], {
            stdio: "ignore",
          });
        } else {
          // Text mode — resolve text from argument or stdin
          let prompt = text;
          if (prompt === undefined && !process.stdin.isTTY) {
            // Read from stdin
            prompt = await readStdin();
          }

          if (prompt === undefined || prompt === "") {
            process.stderr.write(
              JSON.stringify({ error: "No text provided and stdin is not piped" }) + "\n"
            );
            process.exit(2);
          }

          // The dialog would take the text as keys and the Enter as its answer.
          // Read afresh, after the capture: the stdin above can take minutes.
          const screen = await capturePaneContentAsync(tmuxTarget, true);
          if (isDialogOpen(resolveSessionOrExit(target).state, screen)) {
            process.stderr.write(
              JSON.stringify({ error: "Answer the open dialog first", id: session.id }) + "\n"
            );
            process.exit(2);
          }

          // Use tmux buffer pattern to handle large text
          execFileSync("tmux", ["load-buffer", "-b", "claude-mux-input", "-"], {
            input: prompt,
            stdio: ["pipe", "ignore", "ignore"],
          });
          execFileSync(
            "tmux",
            ["paste-buffer", "-b", "claude-mux-input", "-t", tmuxTarget],
            { stdio: "ignore" }
          );
          execFileSync("tmux", ["delete-buffer", "-b", "claude-mux-input"], {
            stdio: "ignore",
          });
          execFileSync("tmux", ["send-keys", "-t", tmuxTarget, "Enter"], {
            stdio: "ignore",
          });
        }

        process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      } catch (err) {
        process.stderr.write(
          JSON.stringify({
            error: "Failed to send to tmux",
            detail: err instanceof Error ? err.message : String(err),
          }) + "\n"
        );
        process.exit(2);
      }
    });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}
