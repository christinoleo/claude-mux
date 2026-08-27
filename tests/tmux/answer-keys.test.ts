import { describe, it, expect } from "vitest";
import { keysForAnswer } from "../../src/tmux/answer-keys.js";

describe("keysForAnswer", () => {
  it("walks down to a single-select option and submits", () => {
    expect(keysForAnswer([0], { multiSelect: false })).toBe("Enter");
    expect(keysForAnswer([2], { multiSelect: false })).toBe("Down Down Enter");
  });

  it("toggles each pick in order for multi-select", () => {
    expect(keysForAnswer([0, 2], { multiSelect: true })).toBe("Space Down Down Space Enter");
    expect(keysForAnswer([1], { multiSelect: true })).toBe("Down Space Enter");
  });

  it("sorts and dedupes picks", () => {
    expect(keysForAnswer([2, 0, 2], { multiSelect: true })).toBe("Space Down Down Space Enter");
  });

  it("refuses selections it cannot express", () => {
    expect(keysForAnswer([], { multiSelect: false })).toBeNull();
    expect(keysForAnswer([], { multiSelect: true })).toBeNull();
    expect(keysForAnswer([0, 1], { multiSelect: false })).toBeNull();
    expect(keysForAnswer([-1], { multiSelect: true })).toBeNull();
  });
});
