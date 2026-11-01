#!/usr/bin/env bun
// HTTP hook endpoint: POST /hook?run=<dir>&delay=<ms>&hang=1
// Logs the same record as display-hook.ts and answers an empty JSON object.
import { appendFileSync } from "fs";
const port = Number(process.argv[2] ?? 39156);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const tStart = Date.now();
    const url = new URL(req.url);
    const input = await req.json();
    const tRead = Date.now();
    const run = url.searchParams.get("run")!;
    const log = (extra = {}) => appendFileSync(run + "/events.jsonl", JSON.stringify({ src: "http", t: tStart / 1000, tRead: tRead / 1000, tEnd: Date.now() / 1000, ev: input.hook_event_name, input, ...extra }) + "\n");
    if (url.searchParams.get("hang")) { log({ hung: true }); await new Promise(() => {}); }
    const delay = Number(url.searchParams.get("delay") ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    log();
    return Response.json({});
  },
});
console.log("listening", port);
