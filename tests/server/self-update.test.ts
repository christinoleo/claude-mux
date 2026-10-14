import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPDATE_DEADLINE_MS, readUpdateJob, selfCommand, startUpdate } from "../../src/server/self-update.js";

/**
 * The update a page starts: run detached, read back from its files. The
 * command is a stand-in shell line, with `update` appended as `claude-mux`
 * would get it.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "self-update-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function settle(): Promise<NonNullable<ReturnType<typeof readUpdateJob>>> {
  for (let i = 0; i < 200; i++) {
    const job = readUpdateJob(dir);
    if (job && job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the update never finished");
}

describe("startUpdate", () => {
  it("runs the update and records its output and success", async () => {
    const { started } = startUpdate({ dir, fromVersion: "0.30.9", command: ["sh", "-c", 'echo "Installing $1"; echo done', "x"] });
    expect(started).toBe(true);
    const job = await settle();
    expect(job).toMatchObject({ state: "ok", exitCode: 0, fromVersion: "0.30.9" });
    expect(job.output).toBe("Installing update\ndone\n");
    expect(job.finishedAt).toEqual(expect.any(Number));
  });

  it("records a failure with its exit code", async () => {
    startUpdate({ dir, fromVersion: "0.30.9", command: ["sh", "-c", "echo npm broke >&2; exit 3", "x"] });
    expect(await settle()).toMatchObject({ state: "failed", exitCode: 3, output: "npm broke\n" });
  });

  it("starts nothing while an update runs, and answers that one", async () => {
    const first = startUpdate({ dir, fromVersion: "a", command: ["sh", "-c", "sleep 0.3", "x"], now: () => 1 });
    const second = startUpdate({ dir, fromVersion: "b", command: ["sh", "-c", "exit 0", "x"], now: () => 2 });
    expect(second.started).toBe(false);
    expect(second.job).toMatchObject({ state: "running", startedAt: 1, fromVersion: "a" });
    expect((await settle()).startedAt).toBe(first.job.startedAt);
  });
});

describe("readUpdateJob", () => {
  it("is null before any update", () => {
    expect(readUpdateJob(dir)).toBeNull();
  });

  it("counts an update whose shell is gone without a result as failed", () => {
    writeFileSync(join(dir, "job.json"), JSON.stringify({ startedAt: 5, fromVersion: "x", pid: 999_999 }));
    writeFileSync(join(dir, "output.log"), "Installing...\n");
    const job = readUpdateJob(dir, () => false);
    expect(job).toMatchObject({ state: "failed", exitCode: null });
    expect(job?.output).toMatch(/ended without a result/);
  });
});

it("counts an update past its deadline as failed, whoever holds its pid now", () => {
  writeFileSync(join(dir, "job.json"), JSON.stringify({ startedAt: 0, fromVersion: "x", pid: 1 }));
  expect(readUpdateJob(dir, () => true, () => UPDATE_DEADLINE_MS + 1)?.state).toBe("failed");
  expect(readUpdateJob(dir, () => true, () => 1)?.state).toBe("running");
});

describe("selfCommand", () => {
  it("runs the CLI the server was started from, else the one on the PATH", () => {
    expect(selfCommand(["bun", "/usr/lib/node_modules/claude-mux/dist/cli.js", "serve"], "/bin/bun")).toEqual([
      "/bin/bun",
      "/usr/lib/node_modules/claude-mux/dist/cli.js",
    ]);
    expect(selfCommand(["node", "/home/u/.npm-global/bin/claude-mux", "serve"], "/bin/node")).toEqual([
      "/bin/node",
      "/home/u/.npm-global/bin/claude-mux",
    ]);
    expect(selfCommand(["node", "/x/node_modules/vite/bin/vite.js", "dev"], "/bin/node")).toEqual(["claude-mux"]);
  });
});
