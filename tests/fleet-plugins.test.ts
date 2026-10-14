import { describe, expect, it } from "vitest";
import {
  AlignPlanSchema,
  alignPlan,
  comparePlugins,
  marketplaceKey,
  pluginKey,
  type MachinePlugins,
  type PluginsReport,
} from "../src/fleet-plugins.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function report(over: Partial<PluginsReport> = {}): PluginsReport {
  return {
    marketplaces: [
      { name: "official", repo: "anthropics/claude-plugins-official", commit: A, latest: A },
      { name: "ak-plugins", repo: "christinoleo/ak-plugins", commit: A, latest: A },
    ],
    plugins: [
      { id: "ak@ak-plugins", version: "1.10.0", enabled: true },
      { id: "posthog@official", version: "1.1.67", enabled: true },
    ],
    readAt: 1000,
    ...over,
  };
}

describe("comparePlugins", () => {
  it("finds the fleet in line when every machine has the same plugins at the latest commit", () => {
    const c = comparePlugins(
      [
        { id: "omarchy", report: report() },
        { id: "engage", report: report() },
      ],
      new Set(),
    );
    expect(c.machines.omarchy.inLine).toBe(true);
    expect(c.machines.engage.inLine).toBe(true);
    expect(c.plugins.every((p) => p.lacking.length === 0)).toBe(true);
  });

  it("flags a machine that lacks a plugin another machine has enabled", () => {
    const c = comparePlugins(
      [
        { id: "omarchy", report: report() },
        { id: "engage", report: report({ plugins: [{ id: "ak@ak-plugins", version: "1.10.0", enabled: true }] }) },
      ],
      new Set(),
    );
    expect(c.machines.engage.inLine).toBe(false);
    expect(c.machines.engage.missing.map((p) => p.name)).toEqual(["posthog"]);
    expect(c.machines.omarchy.inLine).toBe(true);
  });

  it("counts a plugin installed but turned off as lacking, to be enabled", () => {
    const c = comparePlugins(
      [
        { id: "omarchy", report: report() },
        {
          id: "engage",
          report: report({
            plugins: [
              { id: "ak@ak-plugins", version: "1.10.0", enabled: true },
              { id: "posthog@official", version: "1.1.67", enabled: false },
            ],
          }),
        },
      ],
      new Set(),
    );
    expect(c.machines.engage.missing).toEqual([]);
    expect(c.machines.engage.disabled.map((p) => p.name)).toEqual(["posthog"]);
  });

  it("does not want a plugin that is turned off everywhere", () => {
    const off = report({ plugins: [{ id: "posthog@official", version: "1", enabled: false }] });
    const c = comparePlugins(
      [
        { id: "omarchy", report: off },
        { id: "engage", report: report({ plugins: [] }) },
      ],
      new Set(),
    );
    expect(c.machines.engage.inLine).toBe(true);
  });

  it("stops flagging a plugin marked only here", () => {
    const machines: MachinePlugins[] = [
      { id: "omarchy", report: report() },
      { id: "engage", report: report({ plugins: [{ id: "ak@ak-plugins", version: "1.10.0", enabled: true }] }) },
    ];
    const key = pluginKey("posthog@official", report().marketplaces);
    const c = comparePlugins(machines, new Set([key]));
    expect(c.machines.engage.inLine).toBe(true);
    expect(c.plugins.find((p) => p.key === key)?.onlyHere).toBe(true);
  });

  it("flags a marketplace behind the latest commit its source has", () => {
    const c = comparePlugins(
      [
        { id: "omarchy", report: report() },
        {
          id: "engage",
          report: report({
            marketplaces: [
              { name: "official", repo: "anthropics/claude-plugins-official", commit: B, latest: A },
              { name: "ak-plugins", repo: "christinoleo/ak-plugins", commit: A, latest: A },
            ],
          }),
        },
      ],
      new Set(),
    );
    expect(c.machines.engage.behind.map((m) => m.name)).toEqual(["official"]);
    expect(c.machines.engage.inLine).toBe(false);
    expect(c.machines.omarchy.inLine).toBe(true);
  });

  it("takes the latest commit from the newest report", () => {
    const c = comparePlugins(
      [
        { id: "omarchy", report: report({ readAt: 1 }) },
        {
          id: "engage",
          report: report({
            readAt: 2,
            marketplaces: [
              { name: "official", repo: "anthropics/claude-plugins-official", commit: B, latest: B },
              { name: "ak-plugins", repo: "christinoleo/ak-plugins", commit: A, latest: A },
            ],
          }),
        },
      ],
      new Set(),
    );
    expect(c.marketplaces.find((m) => m.name === "official")?.latest).toBe(B);
    expect(c.machines.omarchy.behind.map((m) => m.name)).toEqual(["official"]);
  });

  it("matches one marketplace under different names by its repo", () => {
    const renamed = report({
      marketplaces: [
        { name: "official", repo: "anthropics/claude-plugins-official", commit: A, latest: A },
        { name: "aknakos-workflow", repo: "christinoleo/ak-plugins", commit: A, latest: A },
      ],
      plugins: [
        { id: "ak@aknakos-workflow", version: "1.10.0", enabled: true },
        { id: "posthog@official", version: "1.1.67", enabled: true },
      ],
    });
    const c = comparePlugins(
      [
        { id: "omarchy", report: renamed },
        { id: "engage", report: report() },
      ],
      new Set(),
    );
    expect(c.machines.omarchy.inLine).toBe(true);
    expect(c.plugins.filter((p) => p.name === "ak")).toHaveLength(1);
  });

  it("leaves a machine with no report out of the union and unflagged", () => {
    const c = comparePlugins(
      [
        { id: "omarchy", report: report() },
        { id: "old", report: null },
      ],
      new Set(),
    );
    expect(c.machines.old).toBeUndefined();
    expect(c.machines.omarchy.inLine).toBe(true);
    expect(Object.keys(c.plugins[0].on)).toEqual(["omarchy"]);
  });
});

describe("marketplaceKey", () => {
  it("meets a GitHub repo added by URL with the same repo added from GitHub", () => {
    const key = marketplaceKey({ name: "a", repo: "Christinoleo/ak-plugins" });
    expect(marketplaceKey({ name: "b", repo: "git@github.com:christinoleo/ak-plugins.git" })).toBe(key);
    expect(marketplaceKey({ name: "c", repo: "https://github.com/christinoleo/ak-plugins" })).toBe(key);
    expect(marketplaceKey({ name: "d", repo: "https://gitlab.com/x/y.git" })).toBe("gitlab.com/x/y");
    expect(marketplaceKey({ name: "synced", repo: null })).toBe("name:synced");
  });
});

describe("alignPlan", () => {
  it("installs from the machine's own marketplace name, from the repo when it lacks it, and enables what is off", () => {
    const omarchy = report({
      marketplaces: [
        ...report().marketplaces,
        { name: "marketingskills", repo: "coreyhaines31/marketingskills", commit: A, latest: A },
        { name: "synced", repo: null, commit: null, latest: null },
      ],
      plugins: [
        ...report().plugins,
        { id: "marketing-skills@marketingskills", version: "2", enabled: true },
        { id: "legal@synced", version: "1", enabled: true },
        { id: "beads@ak-plugins", version: "0.4", enabled: true },
      ],
    });
    const engage = report({
      marketplaces: [
        { name: "official", repo: "anthropics/claude-plugins-official", commit: A, latest: A },
        { name: "aknakos", repo: "christinoleo/ak-plugins", commit: A, latest: A },
      ],
      plugins: [
        { id: "ak@aknakos", version: "1.10.0", enabled: true },
        { id: "posthog@official", version: "1.1.67", enabled: false },
      ],
    });
    const c = comparePlugins(
      [
        { id: "omarchy", report: omarchy },
        { id: "engage", report: engage },
      ],
      new Set(),
    );
    const plan = alignPlan(c, "engage");
    expect(plan.enable).toEqual(["posthog@official"]);
    expect(plan.install).toEqual([
      { name: "beads", marketplace: "aknakos" },
      { name: "marketing-skills", repo: "coreyhaines31/marketingskills" },
    ]);
    expect(plan.unreachable).toEqual(["legal@synced"]);
    // The marketplace installed from is updated first, in case it is behind unseen.
    expect(plan.update).toEqual(["aknakos"]);
    expect(alignPlan(c, "omarchy")).toEqual({ update: [], install: [], enable: [], unreachable: [] });
  });

  it("updates only the marketplaces behind, by the machine's own name for them", () => {
    const omarchy = report({ marketplaces: [{ name: "official", repo: "anthropics/claude-plugins-official", commit: B, latest: B }, report().marketplaces[1]] });
    const engage = report({
      marketplaces: [
        { name: "claude-official", repo: "anthropics/claude-plugins-official", commit: A, latest: A },
        { name: "ak-plugins", repo: "christinoleo/ak-plugins", commit: A, latest: A },
      ],
      plugins: [{ id: "ak@ak-plugins", version: "1.10.0", enabled: true }, { id: "posthog@claude-official", version: "1.1.67", enabled: true }],
      readAt: 500,
    });
    const c = comparePlugins(
      [
        { id: "omarchy", report: omarchy },
        { id: "engage", report: engage },
      ],
      new Set(),
    );
    expect(alignPlan(c, "engage").update).toEqual(["claude-official"]);
    expect(alignPlan(c, "omarchy").update).toEqual([]);
    expect(AlignPlanSchema.safeParse({ update: ["--all"] }).success).toBe(false);
  });

  it("is a plan the route accepts, and the route refuses anything that could be read as an option", () => {
    expect(AlignPlanSchema.safeParse({ install: [{ name: "beads", marketplace: "ak" }], enable: ["x@y"] }).success).toBe(true);
    expect(AlignPlanSchema.safeParse({ install: [{ name: "--help", marketplace: "ak" }], enable: [] }).success).toBe(false);
    expect(AlignPlanSchema.safeParse({ install: [], enable: ["-x@y"] }).success).toBe(false);
    expect(AlignPlanSchema.safeParse({ install: [{ name: "a", repo: "--upload-pack=x" }], enable: [] }).success).toBe(false);
  });
});
