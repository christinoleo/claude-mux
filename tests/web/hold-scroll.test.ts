import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdsMove } from "../../web/src/lib/actions/holdScroll.js";

/** Just enough of an element for the scroll checks: its box, its scroll, its style. */
interface Box {
  overflowY?: string;
  overflowX?: string;
  touchAction?: string;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

function box(b: Box): Element {
  return {
    __style: {
      overflowY: b.overflowY ?? "visible",
      overflowX: b.overflowX ?? "visible",
      touchAction: b.touchAction ?? "auto",
    },
    scrollTop: b.scrollTop ?? 0,
    scrollLeft: 0,
    scrollHeight: b.scrollHeight ?? 100,
    clientHeight: b.clientHeight ?? 100,
    scrollWidth: 100,
    clientWidth: 100,
    isConnected: true,
  } as unknown as Element;
}

class Input {
  __style = { overflowX: "visible", overflowY: "visible", touchAction: "auto" };
  isConnected = true;
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: unknown[] = [];
beforeEach(() => {
  saved = [g.getComputedStyle, g.HTMLTextAreaElement, g.HTMLInputElement];
  g.getComputedStyle = (el: { __style: unknown }) => el.__style;
  g.HTMLTextAreaElement = class {};
  g.HTMLInputElement = Input;
});
afterEach(() => {
  [g.getComputedStyle, g.HTMLTextAreaElement, g.HTMLInputElement] = saved;
});

const down = { x: 0, y: 6 };
const up = { x: 0, y: -6 };

describe("holdsMove", () => {
  const header = box({});
  const drawer = box({ overflowY: "hidden" });

  it("stops a drag on a part of the drawer that does not scroll", () => {
    expect(holdsMove([header, drawer], 0, 20, down)).toBe(true);
    expect(holdsMove([header, drawer], 0, -20, up)).toBe(true);
  });

  it("stops a drag on a list too short to scroll", () => {
    const list = box({ overflowY: "auto", scrollHeight: 100, clientHeight: 100 });
    expect(holdsMove([header, list, drawer], 0, -20, up)).toBe(true);
  });

  it("lets a list scroll the way it has room for, and stops it at its end", () => {
    const top = box({ overflowY: "auto", scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
    expect(holdsMove([header, top, drawer], 0, -20, up)).toBe(false);
    expect(holdsMove([header, top, drawer], 0, 20, down)).toBe(true);

    const end = box({ overflowY: "auto", scrollTop: 300, scrollHeight: 400, clientHeight: 100 });
    expect(holdsMove([header, end, drawer], 0, 20, down)).toBe(false);
    expect(holdsMove([header, end, drawer], 0, -20, up)).toBe(true);
  });

  it("follows the finger when it turns back mid-gesture", () => {
    const top = box({ overflowY: "auto", scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
    // Travelled up overall, now coming back down past where the list can go.
    expect(holdsMove([top, drawer], 0, -10, down)).toBe(true);
  });

  it("stops a sideways drag, which nothing in the drawer scrolls", () => {
    expect(holdsMove([header, drawer], -40, 5, { x: -6, y: 0 })).toBe(true);
  });

  it("reads a slanted drag as a scroll, not a sideways move", () => {
    const top = box({ overflowY: "auto", scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
    expect(holdsMove([top, drawer], 3, -2, { x: 3, y: -2 })).toBe(false);
  });

  it("lets a field's text be dragged sideways", () => {
    expect(holdsMove([new Input() as unknown as Element, drawer], -40, 2, { x: -6, y: 0 })).toBe(false);
    expect(holdsMove([new Input() as unknown as Element, drawer], 0, 40, down)).toBe(true);
  });

  it("leaves a drag on a row redrawn under the finger to the list", () => {
    const gone = { ...(box({}) as object), isConnected: false } as unknown as Element;
    expect(holdsMove([gone, drawer], 0, 20, down)).toBe(false);
  });

  it("leaves a touch that has not moved alone", () => {
    expect(holdsMove([header, drawer], 0, 0, { x: 0, y: 0 })).toBe(false);
  });
});
