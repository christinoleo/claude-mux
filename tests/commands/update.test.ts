import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSync = vi.fn();
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

const { prefetchRelease } = await import("../../src/commands/update.js");

describe("prefetchRelease", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("caches the tarball on the first try", async () => {
    spawnSync.mockReturnValue({ status: 0 });
    expect(await prefetchRelease("1.2.3", { delayMs: 0 })).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][1]).toEqual(["cache", "add", "claude-mux@1.2.3"]);
  });

  it("waits out a tarball the registry does not serve yet", async () => {
    spawnSync
      .mockReturnValueOnce({ status: 1, stderr: "E404" })
      .mockReturnValueOnce({ status: 1, stderr: "E404" })
      .mockReturnValue({ status: 0 });
    expect(await prefetchRelease("1.2.3", { delayMs: 0 })).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("gives up after its attempts", async () => {
    spawnSync.mockReturnValue({ status: 1, stderr: "E404" });
    expect(await prefetchRelease("1.2.3", { attempts: 3, delayMs: 0 })).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
});
