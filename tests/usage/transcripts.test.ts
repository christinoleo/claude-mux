import { describe, it, expect } from "vitest";
import { parseUsageLine } from "../../src/usage/transcripts.js";

/** An assistant record shaped like the ones Claude Code writes. */
function line(usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-28T12:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/home/me/Projects/thing",
    requestId: "req-1",
    message: { id: "msg-1", model: "claude-opus-5", usage },
    ...extra,
  });
}

describe("parseUsageLine", () => {
  it("splits cache creation into its 1-hour and 5-minute parts", () => {
    const record = parseUsageLine(
      line({
        input_tokens: 10,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 70, ephemeral_5m_input_tokens: 30 },
        output_tokens: 50,
      })
    );
    expect(record?.totals).toMatchObject({
      uncachedInput: 10,
      cacheRead: 200,
      cacheCreation1h: 70,
      cacheCreation5m: 30,
      output: 50,
    });
  });

  it("treats the flat cache counter as authoritative when the breakdown overshoots", () => {
    const record = parseUsageLine(
      line({
        input_tokens: 1,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_1h_input_tokens: 900 },
        output_tokens: 2,
      })
    );
    expect(record?.totals.cacheCreation1h).toBe(40);
    expect(record?.totals.cacheCreation5m).toBe(0);
  });

  it("counts the whole cache creation as 5-minute when no breakdown is written", () => {
    const record = parseUsageLine(
      line({ input_tokens: 1, cache_creation_input_tokens: 40, output_tokens: 2 })
    );
    expect(record?.totals.cacheCreation5m).toBe(40);
    expect(record?.totals.cacheCreation1h).toBe(0);
  });

  it("clamps thinking tokens to the output they sit inside", () => {
    const record = parseUsageLine(
      line({ input_tokens: 1, output_tokens: 50, output_tokens_details: { thinking_tokens: 900 } })
    );
    expect(record?.totals.thinking).toBe(50);
  });

  it("keys de-duplication on the message and request pair", () => {
    expect(parseUsageLine(line({ input_tokens: 1, output_tokens: 1 }))?.dedupeKey).toBe(
      "msg-1:req-1"
    );
  });

  it("still produces a key when only one half is written", () => {
    const record = parseUsageLine(
      line({ input_tokens: 1, output_tokens: 1 }, { requestId: undefined })
    );
    expect(record?.dedupeKey).toBe("msg-1:");
  });

  it("reads the cost the provider reported when there is one", () => {
    const record = parseUsageLine(
      line({ input_tokens: 1, output_tokens: 1 }, { costUSD: 0.0125 })
    );
    expect(record?.reportedCostUsd).toBe(0.0125);
  });

  it("ignores anything that is not a priced assistant response", () => {
    expect(parseUsageLine("not json")).toBeNull();
    expect(parseUsageLine('{"type":"user","message":{"usage":{}}}')).toBeNull();
    expect(parseUsageLine(line({ input_tokens: 1 }, { message: { usage: {} } }))).toBeNull();
    expect(
      parseUsageLine(line({ input_tokens: 1, output_tokens: 1 }, { timestamp: "nonsense" }))
    ).toBeNull();
  });
});
