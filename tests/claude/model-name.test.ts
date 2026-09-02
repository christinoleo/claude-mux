import { describe, it, expect } from "vitest";
import { modelDisplayName } from "../../src/claude/model-name.js";

describe("modelDisplayName", () => {
  it("turns the API's id into the name the terminal shows", () => {
    expect(modelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelDisplayName("claude-opus-5")).toBe("Opus 5");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
  });

  it("drops a release date and keeps the version", () => {
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelDisplayName("claude-opus-4-1-20250805")).toBe("Opus 4.1");
  });

  it("keeps a long-context suffix and a vendor prefix out of the way", () => {
    expect(modelDisplayName("claude-opus-5[1m]")).toBe("Opus 5 (1M)");
    expect(modelDisplayName("us.anthropic.claude-sonnet-5")).toBe("Sonnet 5");
  });

  it("shows an id it cannot read as it is, and nothing for no id", () => {
    expect(modelDisplayName("gpt-5")).toBe("Gpt 5");
    expect(modelDisplayName("some model")).toBe("some model");
    expect(modelDisplayName(null)).toBeNull();
    expect(modelDisplayName("")).toBeNull();
  });
});
