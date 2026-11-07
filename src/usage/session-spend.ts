/**
 * What one session has cost so far: its transcript and its subagents'
 * (`<id>/subagents/agent-*.jsonl` beside it), priced the way the usage report
 * prices them. The worker queue asks on every pass, so each file is read
 * only from where the last read stopped.
 */

import { existsSync } from "fs";
import { JsonlTailer, listSubagents, subagentDir } from "../transcript/tailer.js";
import { priceUsage, type RateTable } from "./pricing.js";
import { parseUsageLine } from "./transcripts.js";

interface FileState {
  tailer: JsonlTailer;
  costUsd: number;
  seen: Set<string>;
}

export class SpendMeter {
  private files = new Map<string, FileState>();

  constructor(private readonly table: () => Promise<RateTable>) {}

  /** The session's spend in USD, or null when its transcript is not on disk. */
  async spend(transcript: string): Promise<number | null> {
    if (!existsSync(transcript)) return null;
    const table = await this.table();
    let total = this.read(transcript, table);
    for (const agent of listSubagents(transcript)) total += this.read(agent.path, table);
    return total;
  }

  /** Forget files no longer asked about, so a long-running server does not keep every transcript it ever read. */
  keepOnly(transcripts: readonly string[]): void {
    const keep = new Set(transcripts);
    const agentDirs = transcripts.map((t) => `${subagentDir(t)}/`);
    for (const path of this.files.keys()) {
      if (!keep.has(path) && !agentDirs.some((d) => path.startsWith(d))) this.files.delete(path);
    }
  }

  private read(path: string, table: RateTable): number {
    let state = this.files.get(path);
    if (!state) {
      state = { tailer: new JsonlTailer(path), costUsd: 0, seen: new Set() };
      this.files.set(path, state);
    }
    let res = state.tailer.read();
    if (res.status === "reset") {
      // Rewritten from the start: read it again.
      state.costUsd = 0;
      state.seen = new Set();
      res = state.tailer.read();
    }
    if (res.status !== "lines") return state.costUsd;
    for (const line of res.lines) {
      const record = parseUsageLine(line);
      if (!record) continue;
      // Claude Code repeats a message's usage on each of its content blocks.
      if (record.dedupeKey) {
        if (state.seen.has(record.dedupeKey)) continue;
        state.seen.add(record.dedupeKey);
      }
      state.costUsd += priceUsage(table, record.model, record.totals, record.reportedCostUsd).costUsd;
    }
    return state.costUsd;
  }
}
