import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { withSessionLock } from "../../src/db/session-lock.js";

let dir: string;
let path: string;

describe("withSessionLock", () => {
  beforeEach(() => {
    dir = join(tmpdir(), `claude-mux-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "s1.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds the lock file while the change runs and removes it after", () => {
    const seen = withSessionLock(path, () => existsSync(`${path}.lock`));
    expect(seen).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("removes the lock when the change throws", () => {
    expect(() =>
      withSessionLock(path, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("breaks a lock left by a writer that died holding it", () => {
    writeFileSync(`${path}.lock`, "dead");
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(`${path}.lock`, old, old);
    const onTimeout = vi.fn();
    const started = Date.now();
    expect(withSessionLock(path, () => "ran", onTimeout)).toBe("ran");
    expect(onTimeout).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("goes ahead without the lock, and says so, when a live holder keeps it too long", () => {
    writeFileSync(`${path}.lock`, "someone");
    const onTimeout = vi.fn();
    const started = Date.now();
    expect(withSessionLock(path, () => "ran", onTimeout)).toBe("ran");
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(2_000);
    // Not ours, so it stays for its holder to release.
    expect(readFileSync(`${path}.lock`, "utf-8")).toBe("someone");
  });

  it("runs the change even where the directory is missing", () => {
    expect(withSessionLock(join(dir, "gone", "s1.json"), () => "ran")).toBe("ran");
  });
});
