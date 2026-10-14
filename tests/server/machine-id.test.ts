import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMachineId } from "../../src/server/machine-id.js";

describe("loadMachineId", () => {
  it("mints an id once and reads the same one back after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "machine-id-")), "nested", "machine-id");
    const first = loadMachineId(path);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path, "utf8").trim()).toBe(first);
    expect(loadMachineId(path)).toBe(first);
  });

  it("replaces a file that holds no id", () => {
    const path = join(mkdtempSync(join(tmpdir(), "machine-id-")), "machine-id");
    writeFileSync(path, "garbage\n");
    const id = loadMachineId(path);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadMachineId(path)).toBe(id);
  });
});
