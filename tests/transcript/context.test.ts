import { describe, it, expect } from "vitest";
import { contextPercent, contextWindowFor, readContextUsage } from "../../src/transcript/context.js";
import { TranscriptBuilder } from "../../src/transcript/parser.js";

const TS = "2026-08-27T08:33:54.348Z";

function assistantLine(
  model: string,
  usage: Record<string, number> | undefined,
  opts: { sidechain?: boolean; uuid?: string } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    uuid: opts.uuid ?? "a1",
    timestamp: TS,
    isSidechain: opts.sidechain ?? false,
    message: {
      role: "assistant",
      id: "msg_1",
      model,
      content: [{ type: "text", text: "hi" }],
      ...(usage ? { usage } : {}),
    },
  });
}

describe("contextWindowFor", () => {
  it("gives the 1M generation its native window", () => {
    expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-fable-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
  });

  it("gives older models 200k", () => {
    expect(contextWindowFor("claude-opus-4-5")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
  });

  it("honours the [1m] opt-in suffix on a model without a native 1M window", () => {
    expect(contextWindowFor("claude-sonnet-4-6[1m]")).toBe(1_000_000);
  });

  it("looks through the provider prefixes and version suffixes that wrap an id", () => {
    expect(contextWindowFor("us.anthropic.claude-opus-5")).toBe(1_000_000);
    expect(contextWindowFor("anthropic.claude-opus-5-v1:0")).toBe(1_000_000);
    expect(contextWindowFor("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(200_000);
  });

  it("leaves a model it does not know unknown, rather than guessing", () => {
    expect(contextWindowFor("claude-opus-7")).toBeNull();
    expect(contextWindowFor("")).toBeNull();
  });
});

describe("readContextUsage", () => {
  it("sums input and both cache counters", () => {
    const usage = readContextUsage({
      model: "claude-opus-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 539_600,
        output_tokens: 900,
      },
    });
    expect(usage).toEqual({ model: "claude-opus-5", tokens: 540_002, window: 1_000_000 });
    expect(contextPercent(usage!)).toBe(54);
  });

  it("reports tokens without a percentage when the model is unknown", () => {
    const usage = readContextUsage({ model: "claude-opus-7", usage: { input_tokens: 1234 } });
    expect(usage).toEqual({ model: "claude-opus-7", tokens: 1234, window: null });
    expect(contextPercent(usage!)).toBeNull();
  });

  it("ignores a message with no usage, and a zeroed synthetic one", () => {
    expect(readContextUsage({ model: "claude-opus-5" })).toBeNull();
    expect(
      readContextUsage({
        model: "<synthetic>",
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    ).toBeNull();
  });
});

describe("TranscriptBuilder context tracking", () => {
  it("tracks the most recent response and keeps it across usage-less lines", () => {
    const builder = new TranscriptBuilder();
    expect(builder.context).toBeNull();

    builder.feed(assistantLine("claude-opus-5", { input_tokens: 10, cache_read_input_tokens: 90 }));
    expect(builder.context).toEqual({ model: "claude-opus-5", tokens: 100, window: 1_000_000 });

    builder.feed(assistantLine("claude-opus-5", undefined, { uuid: "a2" }));
    expect(builder.context?.tokens).toBe(100);

    builder.feed(
      assistantLine("claude-opus-5", { input_tokens: 10, cache_read_input_tokens: 190 }, { uuid: "a3" }),
    );
    expect(builder.context?.tokens).toBe(200);
  });

  it("ignores subagent responses, which have a context of their own", () => {
    const builder = new TranscriptBuilder();
    builder.feed(assistantLine("claude-opus-5", { input_tokens: 5000 }, { sidechain: true }));
    expect(builder.context).toBeNull();
  });
});
