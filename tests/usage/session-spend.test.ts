import { describe, it, expect } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SpendMeter } from "../../src/usage/session-spend.js";
import { fallbackRateTable } from "../../src/usage/pricing.js";

function line(id: string, cost: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-07T12:00:00Z",
    requestId: `req-${id}`,
    costUSD: cost,
    message: { id, model: "claude-opus-4-5", usage: { input_tokens: 10, output_tokens: 10 } },
  });
}

describe("SpendMeter", () => {
  it("adds a session's transcript and its subagents', each message once, reading only what was appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    const transcript = join(dir, "abc.jsonl");
    writeFileSync(transcript, `${line("m1", 1)}\n${line("m1", 1)}\n${line("m2", 0.5)}\n`);
    mkdirSync(join(dir, "abc", "subagents"), { recursive: true });
    writeFileSync(join(dir, "abc", "subagents", "agent-x.jsonl"), `${line("s1", 0.25)}\n`);
    const meter = new SpendMeter(async () => fallbackRateTable());
    expect(await meter.spend(transcript)).toBeCloseTo(1.75);
    // Half a line, then its end.
    const next = line("m3", 2);
    appendFileSync(transcript, next.slice(0, 20));
    expect(await meter.spend(transcript)).toBeCloseTo(1.75);
    appendFileSync(transcript, `${next.slice(20)}\n`);
    expect(await meter.spend(transcript)).toBeCloseTo(3.75);
    expect(await meter.spend(join(dir, "missing.jsonl"))).toBeNull();
  });
});
