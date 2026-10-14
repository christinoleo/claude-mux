import { describe, expect, it } from "vitest";
import { PluginReader, type RunResult, type Runner } from "../../src/server/plugins.js";

const HEAD = "1".repeat(40);
const GCS = "2".repeat(40);
const LATEST = "3".repeat(40);

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail: RunResult = { code: 1, stdout: "", stderr: "nope" };

/** A fake CLI: `claude plugin … --json`, git and gh, answering as the real ones do. */
function fakeRun(calls: string[][], over: Partial<Record<string, RunResult>> = {}): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(" ");
    if (line in over) return over[line]!;
    if (line === "claude plugin marketplace list --json")
      return ok(
        JSON.stringify([
          { name: "aknakos-workflow", source: "github", repo: "christinoleo/aknakos-workflow", installLocation: "/m/ak" },
          { name: "official", source: "github", repo: "anthropics/claude-plugins-official", installLocation: "/m/off" },
        ]),
      );
    if (line === "claude plugin list --json")
      return ok(
        JSON.stringify([
          { id: "ak@aknakos-workflow", version: "1.10.0", scope: "user", enabled: true },
          { id: "posthog@official", version: "1.1.67", scope: "user", enabled: false },
          { id: "local-thing@official", version: "0.1", scope: "project", enabled: true },
        ]),
      );
    if (line === "git -C /m/ak rev-parse HEAD") return ok(`${HEAD}\n`);
    if (line === "git -C /m/off rev-parse HEAD") return fail;
    if (line === "gh api repos/christinoleo/aknakos-workflow --jq .full_name") return ok("christinoleo/ak-plugins\n");
    if (line === "gh api repos/christinoleo/ak-plugins/commits/HEAD --jq .sha") return ok(`${LATEST}\n`);
    if (line.startsWith("gh ")) return fail;
    if (line === "git ls-remote https://github.com/anthropics/claude-plugins-official.git HEAD") return ok(`${LATEST}\tHEAD\n`);
    return ok("");
  };
}

const readText = async (path: string) => (path === "/m/off/.gcs-sha" ? `${GCS}\n` : null);

describe("PluginReader", () => {
  it("reports marketplaces with their commit and latest, and user-scope plugins", async () => {
    const reader = new PluginReader({ run: fakeRun([]), readText, now: () => 5 });
    const report = await reader.read();
    expect(report).toEqual({
      marketplaces: [
        // GitHub's current name for a renamed repo, so it meets the same marketplace elsewhere.
        { name: "aknakos-workflow", repo: "christinoleo/ak-plugins", commit: HEAD, latest: LATEST },
        // An archive download: the commit from .gcs-sha, the latest through git without gh.
        { name: "official", repo: "anthropics/claude-plugins-official", commit: GCS, latest: LATEST },
      ],
      plugins: [
        { id: "ak@aknakos-workflow", version: "1.10.0", enabled: true },
        { id: "posthog@official", version: "1.1.67", enabled: false },
      ],
      readAt: 5,
    });
  });

  it("answers what it knows at once and reads in the background when stale", async () => {
    let now = 0;
    const calls: string[][] = [];
    const reader = new PluginReader({ run: fakeRun(calls), readText, now: () => now });
    expect(reader.current()).toBeNull();
    await reader.read();
    const first = reader.current();
    expect(first?.readAt).toBe(0);
    const before = calls.length;
    now = 60_000;
    expect(reader.current()).toBe(first);
    expect(calls.length).toBe(before);
    now = 6 * 60_000;
    reader.current();
    await reader.read();
    expect(reader.current()?.readAt).toBe(now);
  });

  it("keeps the last report when the CLI cannot be run", async () => {
    const reader = new PluginReader({ run: fakeRun([]), readText });
    const first = await reader.read();
    const broken = new PluginReader({ run: fakeRun([], { "claude plugin list --json": fail }), readText });
    expect(await broken.read()).toBeNull();
    expect(first).not.toBeNull();
  });
});

describe("PluginReader.align", () => {
  it("updates marketplaces, installs and enables, carrying on past a failure, then reads again", async () => {
    const calls: string[][] = [];
    const run = fakeRun(calls, { "claude plugin install beads@ak": fail });
    const reader = new PluginReader({ run, readText });
    const { steps, report } = await reader.align({
      update: true,
      install: [
        { name: "beads", marketplace: "ak" },
        { name: "marketing-skills", repo: "coreyhaines31/marketingskills" },
      ],
      enable: ["posthog@official"],
    });
    expect(steps.map((s) => [s.command, s.ok])).toEqual([
      ["claude plugin marketplace update", true],
      ["claude plugin install beads@ak", false],
      ["claude plugin install marketing-skills --marketplace coreyhaines31/marketingskills", true],
      ["claude plugin enable posthog@official --scope user", true],
    ]);
    expect(steps[1].output).toBe("nope");
    expect(report?.plugins).toHaveLength(2);
  });
});
