import { describe, expect, it, vi } from "vitest";
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

/** A runner whose `claude plugin marketplace update` calls wait until released. */
function gatedRun(calls: string[][], over: Partial<Record<string, RunResult>> = {}) {
  const gates: { args: string[]; timeoutMs: number; release: (r?: RunResult) => void }[] = [];
  const base = fakeRun(calls, over);
  const run: Runner = (cmd, args, timeoutMs) => {
    if (args[1] !== "marketplace" || args[2] !== "update") return base(cmd, args, timeoutMs);
    calls.push([cmd, ...args]);
    return new Promise((done) => gates.push({ args, timeoutMs, release: (r) => done(r ?? ok("updated")) }));
  };
  return { run, gates };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PluginReader.startAlign", () => {
  it("answers at once with the job running, and reports each step as it starts and ends", async () => {
    const calls: string[][] = [];
    const { run, gates } = gatedRun(calls);
    let now = 1_000;
    const reader = new PluginReader({ run, readText, now: () => now });
    let done = 0;
    const { started, job } = reader.startAlign(
      { update: ["scientific"], install: [{ name: "beads", marketplace: "ak" }], enable: ["posthog@official"] },
      () => done++,
    );
    expect(started).toBe(true);
    expect(job.state).toBe("running");
    expect(job.steps.map((s) => [s.label, s.command, s.state])).toEqual([
      ["Updating scientific", "claude plugin marketplace update scientific", "running"],
      ["Installing beads", "claude plugin install beads@ak", "pending"],
      ["Enabling posthog@official", "claude plugin enable posthog@official --scope user", "pending"],
    ]);
    // Only the marketplace that is behind is fetched, with a limit of minutes.
    expect(gates).toHaveLength(1);
    expect(gates[0].args).toEqual(["plugin", "marketplace", "update", "scientific"]);
    expect(gates[0].timeoutMs).toBeGreaterThanOrEqual(5 * 60_000);

    now = 61_000;
    expect(reader.alignJob()?.steps[0]).toMatchObject({ state: "running", startedAt: 1_000, finishedAt: null });
    gates[0].release();
    await vi.waitFor(() => expect(reader.alignJob()?.state).toBe("done"));
    const end = reader.alignJob()!;
    expect(end.steps.map((s) => s.state)).toEqual(["ok", "ok", "ok"]);
    expect(end.steps[0]).toMatchObject({ output: "updated", finishedAt: 61_000 });
    expect(end.finishedAt).toBe(61_000);
    expect(done).toBe(1);
    // The report is read again after the steps.
    expect(calls.at(-1)?.join(" ")).not.toMatch(/^claude plugin (install|enable|marketplace update)/);
  });

  it("joins a run under way instead of starting another", async () => {
    const calls: string[][] = [];
    const { run, gates } = gatedRun(calls);
    const reader = new PluginReader({ run, readText });
    const first = reader.startAlign({ update: ["a"], install: [], enable: [] });
    const second = reader.startAlign({ update: ["b"], install: [], enable: [] });
    expect(second.started).toBe(false);
    expect(second.job).toEqual(first.job);
    expect(gates).toHaveLength(1);
    gates[0].release();
    await vi.waitFor(() => expect(reader.alignJob()?.state).toBe("done"));
    // Once it has ended, the next ask starts afresh.
    expect(reader.startAlign({ update: ["b"], install: [], enable: [] }).started).toBe(true);
    await tick();
    expect(gates[1].args.at(-1)).toBe("b");
  });

  it("carries on past a failed step and reports a timeout plainly, with the output", async () => {
    const { run, gates } = gatedRun([], { "claude plugin install beads@ak": fail });
    const reader = new PluginReader({ run, readText });
    reader.startAlign({ update: ["slow"], install: [{ name: "beads", marketplace: "ak" }], enable: ["x@y"] });
    gates[0].release({ code: -1, stdout: "Fetching…", stderr: "", timedOut: true });
    await vi.waitFor(() => expect(reader.alignJob()?.state).toBe("done"));
    const [update, install, enable] = reader.alignJob()!.steps;
    expect(update.state).toBe("timeout");
    expect(update.output).toMatch(/^Fetching…\n\(stopped after 10 min without finishing\)$/);
    expect(install).toMatchObject({ state: "failed", output: "nope" });
    expect(enable.state).toBe("ok");
  });

  it("hands out copies, so a reader cannot change the job", () => {
    const { run } = gatedRun([]);
    const reader = new PluginReader({ run, readText });
    expect(reader.alignJob()).toBeNull();
    reader.startAlign({ update: ["a"], install: [], enable: [] }).job.steps[0].state = "ok";
    expect(reader.alignJob()?.steps[0].state).toBe("running");
  });
});
