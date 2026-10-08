import { describe, it, expect } from "vitest";
import { DIVIDER_PX, PANEL_MIN_PX, SESSION_MIN_PX, dragWidth } from "../../web/src/lib/side-panel/layout.js";

describe("dragWidth", () => {
  const rowWidth = 1600;
  const rowRight = 1600;

  it("measures the panel from the pointer to the row's right edge", () => {
    expect(dragWidth(1000, rowRight, rowWidth)).toBe(600 - DIVIDER_PX / 2);
  });

  it("clamps to the panel's minimum width", () => {
    expect(dragWidth(1500, rowRight, rowWidth)).toBe(PANEL_MIN_PX);
  });

  it("refuses a width that would squeeze the session column", () => {
    expect(dragWidth(SESSION_MIN_PX - 20, rowRight, rowWidth)).toBeNull();
    expect(dragWidth(SESSION_MIN_PX + 20, rowRight, rowWidth)).not.toBeNull();
  });
});
