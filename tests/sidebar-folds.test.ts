import { describe, expect, it } from "vitest";
import { agentsFoldKey, isOpen, workersFoldKey } from "../src/sidebar-folds.js";

describe("sidebar folds", () => {
  const key = agentsFoldKey("s1");

  it("takes the caller's default for a row nobody touched", () => {
    expect(isOpen({}, key, false)).toBe(false);
    expect(isOpen({}, workersFoldKey("place"), true)).toBe(true);
  });

  it("keeps a choice over the default", () => {
    expect(isOpen({ [key]: true }, key, false)).toBe(true);
    expect(isOpen({ [key]: false }, key, true)).toBe(false);
  });

  it("remembers each row apart", () => {
    const choices = { [key]: true };
    expect(isOpen(choices, agentsFoldKey("s2"), false)).toBe(false);
    expect(isOpen(choices, workersFoldKey("s1"), true)).toBe(true);
  });
});
