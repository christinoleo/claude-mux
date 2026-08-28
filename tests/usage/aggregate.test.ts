import { describe, it, expect } from "vitest";
import { aggregateUsage, makeDayFormatter, type AttributedRecord } from "../../src/usage/aggregate.js";
import { EMPTY_TOTALS, parseRateTable } from "../../src/usage/pricing.js";

const TABLE = parseRateTable({
  "claude-opus-5": { input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 },
});

function record(
  partial: Partial<AttributedRecord> & { timestampMs: number }
): AttributedRecord {
  const { totals, ...rest } = partial;
  return {
    model: "claude-opus-5",
    sessionId: "sess-1",
    cwd: "/home/me/thing",
    project: "-home-me-thing",
    reportedCostUsd: null,
    dedupeKey: null,
    ...rest,
    totals: { ...EMPTY_TOTALS, ...totals },
  };
}

describe("makeDayFormatter", () => {
  it("cuts the day in the requested zone, not the host's", () => {
    // 01:30 UTC on the 2nd is still the 1st in São Paulo.
    const at = Date.parse("2026-03-02T01:30:00Z");
    expect(makeDayFormatter("America/Sao_Paulo")(at)).toBe("2026-03-01");
    expect(makeDayFormatter("UTC")(at)).toBe("2026-03-02");
  });

  it("handles a zone whose offset is not a whole hour", () => {
    const at = Date.parse("2026-03-01T18:45:00Z");
    expect(makeDayFormatter("Asia/Kathmandu")(at)).toBe("2026-03-02");
  });

  it("falls back to UTC for an unknown zone instead of failing the report", () => {
    expect(makeDayFormatter("Mars/Olympus")(Date.parse("2026-03-02T01:30:00Z"))).toBe("2026-03-02");
  });
});

describe("aggregateUsage", () => {
  const records = [
    record({ timestampMs: Date.parse("2026-03-01T10:00:00Z"), totals: { output: 100 } }),
    record({ timestampMs: Date.parse("2026-03-02T10:00:00Z"), totals: { output: 200 } }),
    record({
      timestampMs: Date.parse("2026-03-02T11:00:00Z"),
      project: "-home-me-other",
      sessionId: "sess-2",
      totals: { output: 500 },
    }),
  ];

  it("emits one cell per project and model pair in a day", () => {
    const report = aggregateUsage(
      [
        record({ timestampMs: Date.parse("2026-03-01T10:00:00Z"), totals: { output: 100 } }),
        record({ timestampMs: Date.parse("2026-03-01T11:00:00Z"), totals: { output: 100 } }),
        record({
          timestampMs: Date.parse("2026-03-01T12:00:00Z"),
          model: "claude-haiku-4-5",
          totals: { output: 50 },
        }),
      ],
      TABLE,
      { timeZone: "UTC" }
    );
    const cells = report.days[0].cells;
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ project: "-home-me-thing", model: "claude-opus-5" });
    expect(cells[0].tokens).toBe(200);
    expect(cells[1].model).toBe("claude-haiku-4-5");
  });

  it("buckets by day and totals the cost", () => {
    const report = aggregateUsage(records, TABLE, { timeZone: "UTC" });
    expect(report.days.map((d) => d.date)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(report.costUsd).toBeCloseTo(800 * 1e-5, 12);
    expect(report.sessions).toBe(2);
    expect(report.records).toBe(3);
  });

  it("ranks projects by cost and labels them from the map", () => {
    const report = aggregateUsage(records, TABLE, {
      timeZone: "UTC",
      projectLabels: new Map([["-home-me-other", "/home/me/other"]]),
    });
    expect(report.projects[0]).toMatchObject({ key: "-home-me-other", label: "/home/me/other" });
    expect(report.projects[1].label).toBe("-home-me-thing");
  });

  it("honours the window bounds", () => {
    const report = aggregateUsage(records, TABLE, {
      timeZone: "UTC",
      fromMs: Date.parse("2026-03-02T00:00:00Z"),
    });
    expect(report.records).toBe(2);
    expect(report.days).toHaveLength(1);
  });

  it("marks a model the table cannot price", () => {
    const report = aggregateUsage(
      [record({ timestampMs: Date.now(), model: "<synthetic>" })],
      TABLE,
      { timeZone: "UTC" }
    );
    expect(report.models[0]).toMatchObject({ model: "<synthetic>", priced: false, costUsd: 0 });
  });
});
