import { describe, it, expect } from "vitest";
import { keysForAnswer, keysForOptionMove, keysForOptionPick } from "../../src/tmux/answer-keys.js";

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

describe("keysForOptionPick", () => {
  it("submits in place when the row is already highlighted", () => {
    expect(keysForOptionPick(0, 0, 3)).toBe("Enter");
    expect(keysForOptionPick(2, 2, 3)).toBe("Enter");
  });

  it("walks down to a row below the highlight", () => {
    expect(keysForOptionPick(0, 2, 3)).toBe("Down Down Enter");
  });

  it("walks up to a row above the highlight", () => {
    expect(keysForOptionPick(2, 0, 3)).toBe("Up Up Enter");
  });

  it("assumes the first row when the pane marks none", () => {
    expect(keysForOptionPick(-1, 1, 3)).toBe("Down Enter");
  });

  it("refuses a row the dialog does not have", () => {
    expect(keysForOptionPick(0, 3, 3)).toBeNull();
    expect(keysForOptionPick(0, -1, 3)).toBeNull();
  });
});

describe("keysForOptionMove", () => {
  it("walks the highlight to a row without picking it", () => {
    expect(keysForOptionMove(0, 2, 4)).toBe("Down Down");
    expect(keysForOptionMove(3, 1, 4)).toBe("Up Up");
  });

  it("sends nothing when the highlight is already there, and starts at the top when none is marked", () => {
    expect(keysForOptionMove(1, 1, 4)).toBe("");
    expect(keysForOptionMove(-1, 1, 4)).toBe("Down");
  });

  it("refuses a row that does not exist", () => {
    expect(keysForOptionMove(0, 4, 4)).toBeNull();
    expect(keysForOptionMove(0, -1, 4)).toBeNull();
  });
});
