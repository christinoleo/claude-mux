#!/usr/bin/env bun
// MessageDisplay probe hook, written the way src/hooks/claude-mux-hook.ts is:
// a TypeScript file run by bun, reading JSON from stdin. Optional behaviour
// comes from the environment so the settings file picks the condition.
//   PROBE_RUN    directory that receives events.jsonl
//   MUX_SRC      claude-mux src/ directory; imports what the real hook imports
//   DELAY_MS     hold the hook this long before exiting
//   REWRITE      print displayContent with the delta upper-cased
import { appendFileSync } from "fs";
const tStart = Date.now();
if (process.env.MUX_SRC) {
  await import(process.env.MUX_SRC + "/transcript/mcp.ts");
  await import(process.env.MUX_SRC + "/transcript/tailer.ts");
  await import(process.env.MUX_SRC + "/db/session-lock.ts");
  await import(process.env.MUX_SRC + "/session-state.ts");
}
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const tRead = Date.now();
const delay = Number(process.env.DELAY_MS ?? 0);
if (delay) await new Promise((r) => setTimeout(r, delay));
appendFileSync(
  process.env.PROBE_RUN + "/events.jsonl",
  JSON.stringify({ src: "bun", pid: process.pid, t: tStart / 1000, tRead: tRead / 1000, tEnd: Date.now() / 1000, ev: input.hook_event_name, input }) + "\n",
);
if (process.env.REWRITE && input.delta) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent: String(input.delta).toUpperCase() } }));
}
