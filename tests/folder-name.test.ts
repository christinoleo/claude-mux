import { describe, expect, it } from "vitest";
import { folderNameProblem } from "../src/folder-name.js";

describe("folderNameProblem", () => {
  it("takes an ordinary name", () => {
    expect(folderNameProblem("meu-app")).toBeNull();
    expect(folderNameProblem(".config")).toBeNull();
    expect(folderNameProblem("two words")).toBeNull();
  });

  it("refuses what would leave the folder on screen or name nothing", () => {
    for (const name of ["", "  ", "a/b", "/abs", "..", ".", "a\0b", " lead", "trail ", "x".repeat(256)]) {
      expect(folderNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
  });
});
