import { describe, it, expect } from "vitest";
import { buildFleetReport, mergeReports, type MachineInput } from "../../src/usage/fleet.js";
import type { UsageReport } from "../../src/usage/aggregate.js";
import type { UsageResponse } from "../../src/usage/report.js";
import { EMPTY_TOTALS } from "../../src/usage/pricing.js";

function report(partial: Partial<UsageReport>): UsageReport {
  return {
    timeZone: "UTC",
    costUsd: 0,
    cacheSavingsUsd: 0,
    totals: EMPTY_TOTALS,
    days: [],
    projects: [],
    models: [],
    sessions: 0,
    records: 0,
    ...partial,
  };
}

const HOST_A: MachineInput = {
  hostname: "alpha",
  report: report({
    costUsd: 10,
    cacheSavingsUsd: 4,
    sessions: 2,
    records: 20,
    totals: { ...EMPTY_TOTALS, output: 100 },
    days: [
      {
        date: "2026-03-01",
        costUsd: 10,
        totals: { ...EMPTY_TOTALS, output: 100 },
        cells: [{ project: "-p", model: "claude-opus-5", costUsd: 10, tokens: 100 }],
      },
    ],
    projects: [{ key: "-p", label: "/p", costUsd: 10, tokens: 100 }],
    models: [{ model: "claude-opus-5", costUsd: 10, tokens: 100, priced: true }],
  }),
};

const HOST_B: MachineInput = {
  hostname: "beta",
  report: report({
    costUsd: 5,
    cacheSavingsUsd: 1,
    sessions: 1,
    records: 7,
    totals: { ...EMPTY_TOTALS, output: 50 },
    days: [
      {
        date: "2026-03-01",
        costUsd: 5,
        totals: { ...EMPTY_TOTALS, output: 50 },
        cells: [{ project: "-p", model: "claude-opus-5", costUsd: 5, tokens: 50 }],
      },
    ],
    projects: [{ key: "-p", label: "/p", costUsd: 5, tokens: 50 }],
    models: [{ model: "claude-opus-5", costUsd: 5, tokens: 50, priced: true }],
  }),
};

describe("mergeReports", () => {
  it("adds cost across machines", () => {
    const merged = mergeReports([HOST_A, HOST_B], "UTC");
    expect(merged.costUsd).toBe(15);
    expect(merged.cacheSavingsUsd).toBe(5);
    expect(merged.totals.output).toBe(150);
    expect(merged.sessions).toBe(3);
    expect(merged.records).toBe(27);
  });

  it("tags every cell with the machine it came from", () => {
    const merged = mergeReports([HOST_A, HOST_B], "UTC");
    expect(merged.days).toHaveLength(1);
    expect(merged.days[0].cells.map((c) => c.machine)).toEqual(["alpha", "beta"]);
    expect(merged.days[0].costUsd).toBe(15);
  });

  it("folds the same repo on two machines into one project row", () => {
    const merged = mergeReports([HOST_A, HOST_B], "UTC");
    expect(merged.projects).toHaveLength(1);
    expect(merged.projects[0]).toMatchObject({ key: "-p", costUsd: 15, tokens: 150 });
    expect(merged.models[0].costUsd).toBe(15);
  });

  it("reports an unreachable machine instead of dropping it", () => {
    const merged = mergeReports(
      [HOST_A, { hostname: "gamma", report: null, error: "HTTP 404" }],
      "UTC"
    );
    expect(merged.costUsd).toBe(10);
    expect(merged.machines).toEqual([
      { hostname: "alpha", ok: true, costUsd: 10 },
      { hostname: "gamma", ok: false, costUsd: 0, error: "HTTP 404" },
    ]);
  });

  it("does not mutate the reports it was handed", () => {
    const merged = mergeReports([HOST_A, HOST_B], "UTC");
    merged.days[0].cells.push({ project: "x", model: "y", costUsd: 99, tokens: 0 });
    expect(HOST_A.report?.days[0].cells).toHaveLength(1);
    expect(HOST_A.report?.projects[0].costUsd).toBe(10);
  });
});

const LOCAL: UsageResponse = {
  ...(HOST_A.report as UsageReport),
  generatedAtMs: 0,
  rates: { source: "cache", fetchedAtMs: 1 },
  scan: { filesParsed: 1, filesReused: 2, crossFileDuplicates: 0 },
  unpricedModels: [],
};

describe("buildFleetReport", () => {
  const discovery = {
    self: "alpha",
    servers: [
      { hostname: "alpha", url: "https://alpha:3456" },
      { hostname: "beta", url: "https://beta:3456" },
    ],
  };

  it("adds a peer's report to the local one and never re-fetches itself", async () => {
    const asked: string[] = [];
    const report = await buildFleetReport({
      days: 7,
      discover: () => Promise.resolve(discovery),
      loadLocal: () => Promise.resolve(LOCAL),
      fetch: ((url: string) => {
        asked.push(url);
        return Promise.resolve(new Response(JSON.stringify(HOST_B.report)));
      }) as unknown as typeof fetch,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("https://beta:3456/api/usage?days=7");
    expect(report.costUsd).toBe(15);
    expect(report.machines.map((m) => m.hostname)).toEqual(["alpha", "beta"]);
  });

  it("reports a peer that answers with an error status", async () => {
    const report = await buildFleetReport({
      days: 7,
      discover: () => Promise.resolve(discovery),
      loadLocal: () => Promise.resolve(LOCAL),
      fetch: (() =>
        Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch,
    });
    expect(report.costUsd).toBe(10);
    expect(report.machines[1]).toMatchObject({ hostname: "beta", ok: false, error: "HTTP 404" });
  });

  it("reports a peer that never answers", async () => {
    const report = await buildFleetReport({
      days: 7,
      discover: () => Promise.resolve(discovery),
      loadLocal: () => Promise.resolve(LOCAL),
      fetch: (() => Promise.reject(new Error("timed out"))) as unknown as typeof fetch,
    });
    expect(report.machines[1]).toMatchObject({ ok: false, error: "timed out" });
  });

  it("still reports the local host when discovery itself failed", async () => {
    const report = await buildFleetReport({
      days: 7,
      discover: () => Promise.resolve({ servers: [], self: "", error: "tailscale missing" }),
      loadLocal: () => Promise.resolve(LOCAL),
      fetch: (() => Promise.reject(new Error("unused"))) as unknown as typeof fetch,
    });
    expect(report.discoveryError).toBe("tailscale missing");
    expect(report.machines).toEqual([{ hostname: "local", ok: true, costUsd: 10 }]);
  });
});
