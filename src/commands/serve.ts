import { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CLAUDE_WATCH_DIR, SESSIONS_DIR, DEFAULT_SERVER_PORT } from "../utils/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  port: string;
  host: string;
}

export async function runServe(options: ServeOptions): Promise<void> {
  // Auto-create data directories if needed
  if (!existsSync(CLAUDE_WATCH_DIR)) {
    mkdirSync(CLAUDE_WATCH_DIR, { recursive: true });
  }
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  // Path to built SvelteKit handler
  const handlerPath = join(__dirname, "..", "web", "handler.js");

  if (!existsSync(handlerPath)) {
    console.error(`SvelteKit handler not found at: ${handlerPath}`);
    console.error("Run 'bun run build' first.");
    process.exit(1);
  }

  // Import the handler module
  const { getHandler } = await import(handlerPath);
  const { fetch: handlerFetch, websocket } = getHandler();

  // Start server with WebSocket compression enabled
  const server = Bun.serve({
    port: Number(options.port),
    hostname: options.host,
    fetch: handlerFetch,
    // Enable perMessageDeflate for WebSocket compression (RFC 7692)
    // This typically achieves 70-80% compression on JSON/text messages
    ...(websocket
      ? {
          websocket: {
            ...websocket,
            perMessageDeflate: true,
          },
        }
      : {}),
  });

  console.log(
    `Listening on ${server.url}${websocket ? " with WebSocket (compression enabled)" : ""}`
  );

  // Graceful shutdown
  const gracefulShutdown = async (signal: string): Promise<void> => {
    console.info(`\nReceived ${signal}, stopping server...`);
    await server.stop(true);
    console.info("Server stopped");
    process.exit(0);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

export function createServeCommand(): Command {
  return new Command("serve")
    .description("Start HTTP server only (no TUI, no tmux required)")
    .option("--port <number>", "Server port", String(DEFAULT_SERVER_PORT))
    .option("--host <address>", "Server host (use 0.0.0.0 for LAN)", "127.0.0.1")
    .action(runServe);
}
