import { describe, it, expect } from "vitest";
import { placeTurnChanges, type Turn } from "../../web/src/lib/side-panel/changes.js";

function turn(id: string, n: number): Turn {
  return {
    id,
    n,
    ts: 0,
    prompt: `prompt ${n}`,
    files: [
      { file: "/repo/a.ts", kind: "modified", additions: 3, deletions: 1 },
      { file: "/repo/b.ts", kind: "added", additions: 10, deletions: 0 },
    ],
  };
}

const items = [
  { id: "p1", kind: "user" },
  { id: "t1", kind: "text" },
  { id: "g1", kind: "group" },
  { id: "p2", kind: "user" },
  { id: "t2", kind: "text" },
  { id: "p3", kind: "user" },
  { id: "x3", kind: "tool" },
  { id: "t3", kind: "text" },
];

describe("placeTurnChanges", () => {
  it("puts each turn's summary after the last item before the next prompt", () => {
    const placed = placeTurnChanges(items, [turn("p1", 1), turn("p3", 3)], false);
    expect([...placed].map(([at, t]) => [at, t.n])).toEqual([
      ["g1", 1],
      ["t3", 3],
    ]);
  });

  it("holds back the last turn while the session is still on it", () => {
    const placed = placeTurnChanges(items, [turn("p1", 1), turn("p3", 3)], true);
    expect([...placed.keys()]).toEqual(["g1"]);
  });

  it("skips a turn whose prompt is above the loaded tail", () => {
    const tail = items.slice(1);
    const placed = placeTurnChanges(tail, [turn("p1", 1), turn("p2", 2)], false);
    expect([...placed].map(([at, t]) => [at, t.n])).toEqual([["t2", 2]]);
  });

  it("ignores changes logged before any prompt", () => {
    const early: Turn = { ...turn("x", 0), id: null };
    expect(placeTurnChanges(items, [early], false).size).toBe(0);
  });
});
