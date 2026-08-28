import { describe, it, expect } from "vitest";
import {
  cacheSavingsUsd,
  EMPTY_TOTALS,
  fallbackRateTable,
  lookupRate,
  parseRateTable,
  priceUsage,
  type TokenTotals,
} from "../../src/usage/pricing.js";

const DOCUMENT = {
  "claude-opus-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  // The shape that breaks a naive last-wins merge: same normalized name, no
  // 1-hour rate. Observed on deepinfra and openrouter entries.
  "deepinfra/anthropic/claude-opus-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
  },
  "model-without-output": { input_cost_per_token: 1e-6 },
};

const totals = (partial: Partial<TokenTotals>): TokenTotals => ({
  ...EMPTY_TOTALS,
  ...partial,
});

describe("parseRateTable", () => {
  it("keeps the canonical entry when a prefixed one normalizes to the same name", () => {
    const rate = lookupRate(parseRateTable(DOCUMENT), "claude-opus-5");
    expect(rate?.cacheWrite1hPerToken).toBe(1e-5);
  });

  it("still resolves a fully spelled provider name", () => {
    const rate = lookupRate(parseRateTable(DOCUMENT), "deepinfra/anthropic/claude-opus-5");
    expect(rate?.inputPerToken).toBe(5e-6);
  });

  it("drops entries missing either half of the base rate", () => {
    expect(lookupRate(parseRateTable(DOCUMENT), "model-without-output")).toBeNull();
  });

  it("derives an unpublished 1-hour write as twice the input rate", () => {
    const table = parseRateTable({
      solo: { input_cost_per_token: 3e-6, output_cost_per_token: 1e-5 },
    });
    expect(lookupRate(table, "solo")?.cacheWrite1hPerToken).toBe(6e-6);
  });

  it("prices cached input as plain input rather than as free when a rate is absent", () => {
    const table = parseRateTable({
      solo: { input_cost_per_token: 3e-6, output_cost_per_token: 1e-5 },
    });
    expect(lookupRate(table, "solo")?.cacheReadPerToken).toBe(3e-6);
  });
});

describe("lookupRate", () => {
  it("refuses synthetic messages and bare family names", () => {
    const table = parseRateTable(DOCUMENT);
    for (const model of ["<synthetic>", "opus", "sonnet", "haiku", "fable", ""]) {
      expect(lookupRate(table, model)).toBeNull();
    }
  });
});

describe("priceUsage", () => {
  const table = parseRateTable(DOCUMENT);

  it("charges each cache tier at its own rate", () => {
    const priced = priceUsage(
      table,
      "claude-opus-5",
      totals({ uncachedInput: 1000, cacheRead: 1000, cacheCreation5m: 1000, cacheCreation1h: 1000, output: 1000 }),
      null
    );
    expect(priced.source).toBe("priced");
    expect(priced.costUsd).toBeCloseTo(
      1000 * 5e-6 + 1000 * 5e-7 + 1000 * 6.25e-6 + 1000 * 1e-5 + 1000 * 2.5e-5,
      12
    );
  });

  it("never charges thinking tokens twice", () => {
    const withThinking = priceUsage(table, "claude-opus-5", totals({ output: 100, thinking: 80 }), null);
    const without = priceUsage(table, "claude-opus-5", totals({ output: 100 }), null);
    expect(withThinking.costUsd).toBe(without.costUsd);
  });

  it("prefers a cost the provider reported over the table", () => {
    const priced = priceUsage(table, "claude-opus-5", totals({ output: 1_000_000 }), 0.42);
    expect(priced).toEqual({ costUsd: 0.42, source: "reported" });
  });

  it("reports an unknown model as unpriced rather than free-looking zero cost", () => {
    expect(priceUsage(table, "claude-from-the-future", totals({ output: 100 }), null)).toEqual({
      costUsd: 0,
      source: "unpriced",
    });
  });
});

describe("cacheSavingsUsd", () => {
  it("counts reads as a saving and writes as a premium", () => {
    const table = parseRateTable(DOCUMENT);
    expect(cacheSavingsUsd(table, "claude-opus-5", totals({ cacheRead: 1000 }))).toBeCloseTo(
      1000 * (5e-6 - 5e-7),
      12
    );
    expect(cacheSavingsUsd(table, "claude-opus-5", totals({ cacheCreation1h: 1000 }))).toBeCloseTo(
      1000 * (5e-6 - 1e-5),
      12
    );
  });
});

describe("fallbackRateTable", () => {
  it("prices the models this host actually runs without a network", () => {
    const table = fallbackRateTable();
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
      expect(lookupRate(table, model), model).not.toBeNull();
    }
  });
});
