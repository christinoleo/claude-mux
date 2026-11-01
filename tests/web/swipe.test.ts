import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrollOffsets, scrolledSince, scrollTakesIt } from "../../web/src/lib/actions/swipe.js";

function box(scrollLeft: number, scrollTop: number): Element {
  return { scrollLeft, scrollTop } as Element;
}

describe("scrolledSince", () => {
  it("reads a flick that carried a code block to its end as a scroll", () => {
    const code = box(0, 0);
    const offsets = scrollOffsets([code]);
    code.scrollLeft = 300;
    expect(scrolledSince([code], offsets, "x")).toBe(true);
  });

  it("is not fooled by the transcript creeping down during a sideways swipe", () => {
    const output = box(0, 500);
    const offsets = scrollOffsets([output]);
    output.scrollTop = 503;
    expect(scrolledSince([output], offsets, "x")).toBe(false);
    expect(scrolledSince([output], offsets, "y")).toBe(true);
  });

  it("leaves a swipe that moved nothing to be a swipe", () => {
    const path = [box(0, 0), box(0, 200)];
    expect(scrolledSince(path, scrollOffsets(path), "x")).toBe(false);
  });
});

describe("scrollTakesIt on a table", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = [g.getComputedStyle, g.HTMLTextAreaElement];
  beforeEach(() => {
    g.getComputedStyle = () => ({ overflowX: "auto", overflowY: "visible", touchAction: "auto" });
    g.HTMLTextAreaElement = class {};
  });
  afterEach(() => {
    [g.getComputedStyle, g.HTMLTextAreaElement] = saved;
  });

  const scroller = (tagName: string, scrollLeft: number, scrollWidth: number) =>
    ({ tagName, scrollLeft, scrollWidth, clientWidth: 300 }) as unknown as Element;

  it("keeps a wide table's gesture at both its ends", () => {
    expect(scrollTakesIt([scroller("TABLE", 300, 600)], "x", false)).toBe(true);
    expect(scrollTakesIt([scroller("TABLE", 0, 600)], "x", true)).toBe(true);
  });

  it("lets a table that fits, and a code block at its end, pass the swipe on", () => {
    expect(scrollTakesIt([scroller("TABLE", 0, 300)], "x", false)).toBe(false);
    expect(scrollTakesIt([scroller("PRE", 300, 600)], "x", false)).toBe(false);
  });
});
