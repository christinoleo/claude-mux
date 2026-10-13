import { describe, it, expect } from "vitest";
import {
  buttonName,
  filterTabs,
  heldButton,
  keyMessage,
  modifiersOf,
  pickTab,
  textDelta,
  toPagePoint,
  UNZOOMED,
  zoomView,
} from "../../web/src/lib/side-panel/browser.js";

const key = (over: Partial<Parameters<typeof keyMessage>[0]>) => ({
  key: "a",
  code: "KeyA",
  keyCode: 65,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("toPagePoint", () => {
  const box = { left: 100, top: 50, width: 600, height: 400 };
  const frame = { width: 2400, height: 1600 };

  it("maps a point on the scaled canvas back to the page's CSS pixels", () => {
    expect(toPagePoint(100, 50, box, frame)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint(400, 250, box, frame)).toEqual({ x: 1200, y: 800 });
    expect(toPagePoint(700, 450, box, frame)).toEqual({ x: 2400, y: 1600 });
  });

  it("holds a drag that leaves the canvas to its edge", () => {
    expect(toPagePoint(0, 9999, box, frame)).toEqual({ x: 0, y: 1600 });
    expect(toPagePoint(5, 5, { ...box, width: 0 }, frame)).toEqual({ x: 0, y: 0 });
  });
});

describe("modifiers and buttons", () => {
  it("packs the modifier keys the way CDP reads them", () => {
    expect(modifiersOf(key({}))).toBe(0);
    expect(modifiersOf(key({ altKey: true, shiftKey: true }))).toBe(9);
    expect(modifiersOf(key({ ctrlKey: true, metaKey: true }))).toBe(6);
  });

  it("names buttons", () => {
    expect([0, 1, 2, 9].map(buttonName)).toEqual(["left", "middle", "right", "none"]);
    expect([0, 1, 2, 4, 3].map(heldButton)).toEqual(["none", "left", "right", "middle", "left"]);
  });
});

describe("keyMessage", () => {
  it("gives a key that types its text, Enter a carriage return, and others none", () => {
    expect(keyMessage(key({}), "down")).toMatchObject({ type: "key", event: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" });
    expect(keyMessage(key({ key: "Enter", code: "Enter", keyCode: 13 }), "down")?.text).toBe("\r");
    expect(keyMessage(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }), "down")).not.toHaveProperty("text");
    expect(keyMessage(key({}), "up")).not.toHaveProperty("text");
  });

  it("sends a shortcut as a key with no text", () => {
    const msg = keyMessage(key({ ctrlKey: true }), "down");
    expect(msg).toMatchObject({ key: "a", modifiers: 2 });
    expect(msg).not.toHaveProperty("text");
  });

  it("keeps paste and the side panel's own shortcuts on this side", () => {
    expect(keyMessage(key({ key: "v", ctrlKey: true }), "down")).toBeNull();
    expect(keyMessage(key({ key: "V", metaKey: true }), "up")).toBeNull();
    expect(keyMessage(key({ key: "W", altKey: true, shiftKey: true }), "down")).toBeNull();
  });
});

describe("textDelta", () => {
  it("types what was appended", () => {
    expect(textDelta("", "h")).toEqual({ backspaces: 0, insert: "h" });
    expect(textDelta("hel", "hello")).toEqual({ backspaces: 0, insert: "lo" });
  });

  it("deletes back to where the two part, then types the rest", () => {
    expect(textDelta("hello", "hell")).toEqual({ backspaces: 1, insert: "" });
    expect(textDelta("teh", "the ")).toEqual({ backspaces: 2, insert: "he " });
    expect(textDelta("same", "same")).toEqual({ backspaces: 0, insert: "" });
  });

  it("counts an emoji as one character", () => {
    expect(textDelta("a😀", "a")).toEqual({ backspaces: 1, insert: "" });
  });
});

describe("pickTab", () => {
  const tabs = [
    { id: "AAAAAAAA", title: "A", url: "https://a.example/" },
    { id: "BBBBBBBB", title: "B", url: "https://b.example/" },
    { id: "CCCCCCCC", title: "C", url: "https://c.example/" },
  ];

  it("prefers the pinned tab, then the session's, then the first", () => {
    expect(pickTab({ tabs, preferred: "BBBBBBBB" }, "CCCCCCCC")?.id).toBe("CCCCCCCC");
    expect(pickTab({ tabs, preferred: "BBBBBBBB" }, undefined)?.id).toBe("BBBBBBBB");
    expect(pickTab({ tabs, preferred: null }, undefined)?.id).toBe("AAAAAAAA");
  });

  it("stays on the tab already showing rather than follow a URL that no longer matches", () => {
    expect(pickTab({ tabs, preferred: null }, undefined, "CCCCCCCC")?.id).toBe("CCCCCCCC");
    expect(pickTab({ tabs, preferred: "BBBBBBBB" }, undefined, "CCCCCCCC")?.id).toBe("CCCCCCCC");
    expect(pickTab({ tabs, preferred: "BBBBBBBB" }, "AAAAAAAA", "CCCCCCCC")?.id).toBe("AAAAAAAA");
    expect(pickTab({ tabs, preferred: "BBBBBBBB" }, undefined, "GONEGONE")?.id).toBe("BBBBBBBB");
  });

  it("moves on when the pinned tab has closed", () => {
    expect(pickTab({ tabs, preferred: "BBBBBBBB" }, "GONEGONE")?.id).toBe("BBBBBBBB");
    expect(pickTab({ tabs: [], preferred: null }, "GONEGONE")).toBeNull();
    expect(pickTab(null, undefined)).toBeNull();
  });
});

describe("filterTabs", () => {
  const tabs = [
    { id: "AAAAAAAA", title: "Inbox", url: "https://mail.example/" },
    { id: "BBBBBBBB", title: "Docs", url: "https://docs.example/inbox-rules" },
  ];
  it("matches every word against title and URL", () => {
    expect(filterTabs(tabs, "")).toHaveLength(2);
    expect(filterTabs(tabs, "INBOX").map((t) => t.id)).toEqual(["AAAAAAAA", "BBBBBBBB"]);
    expect(filterTabs(tabs, "inbox docs").map((t) => t.id)).toEqual(["BBBBBBBB"]);
    expect(filterTabs(tabs, "nothing")).toEqual([]);
  });
});

describe("zoomView", () => {
  // A 400x200 canvas whose centre is at (300, 200).
  const box = { left: 100, top: 100, width: 400, height: 200 };

  it("zooms about the point under the pointer", () => {
    const at = { x: 200, y: 150 };
    const v = zoomView(UNZOOMED, at, at, 2, box);
    expect(v.scale).toBe(2);
    // The point 100 left and 50 above centre stays under the pointer: centre + shift + scale * offset.
    expect(300 + v.x + 2 * -100).toBe(200);
    expect(200 + v.y + 2 * -50).toBe(150);
  });

  it("carries the picture with a pinch whose midpoint moves", () => {
    const zoomed = zoomView(UNZOOMED, { x: 300, y: 200 }, { x: 300, y: 200 }, 4, box);
    expect(zoomView(zoomed, { x: 300, y: 200 }, { x: 350, y: 180 }, 1, box)).toEqual({ scale: 4, x: 50, y: -20 });
  });

  it("never shrinks below the fit, nor leaves a gap at an edge", () => {
    expect(zoomView(UNZOOMED, { x: 0, y: 0 }, { x: 900, y: 900 }, 0.5, box)).toEqual(UNZOOMED);
    expect(zoomView(UNZOOMED, { x: 100, y: 100 }, { x: 900, y: 900 }, 2, box)).toEqual({ scale: 2, x: 200, y: 100 });
    expect(zoomView(UNZOOMED, { x: 300, y: 200 }, { x: 300, y: 200 }, 100, box).scale).toBe(8);
  });

  it("lets the picture grow into the room around it before it can be moved", () => {
    // A phone: the canvas is as wide as the stage and a fraction of its height.
    const room = { width: 400, height: 800 };
    const v = zoomView(UNZOOMED, { x: 100, y: 100 }, { x: 900, y: 900 }, 2, box, room);
    expect(v).toEqual({ scale: 2, x: 200, y: 0 });
    expect(zoomView(UNZOOMED, { x: 300, y: 200 }, { x: 300, y: 900 }, 6, box, room).y).toBe(200);
  });
});
