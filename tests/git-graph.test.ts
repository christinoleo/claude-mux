import { describe, it, expect } from "vitest";
import { layoutGraph } from "../src/git-graph.js";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("layoutGraph", () => {
  it("keeps a single line of history in one lane", () => {
    const g = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(g.width).toBe(1);
    expect(g.rows).toEqual([
      { lane: 0, into: [], through: [], out: [0] },
      { lane: 0, into: [0], through: [], out: [0] },
      { lane: 0, into: [0], through: [], out: [] },
    ]);
  });

  it("gives a second tip its own lane and joins it where the branches fork", () => {
    // main: m2 - m1 - base ; worker: w1 - base
    const g = layoutGraph([c("m2", "m1"), c("w1", "base"), c("m1", "base"), c("base")]);
    expect(g.width).toBe(2);
    expect(g.rows[1]).toEqual({ lane: 1, into: [], through: [0], out: [1] });
    expect(g.rows[2]).toEqual({ lane: 0, into: [0], through: [1], out: [0] });
    // Both lanes were waiting for base: the commit sits in the first and the other ends here.
    expect(g.rows[3]).toEqual({ lane: 0, into: [0, 1], through: [], out: [] });
  });

  it("opens a lane for a merge's second parent", () => {
    const g = layoutGraph([c("merge", "a", "b"), c("b", "root"), c("a", "root"), c("root")]);
    expect(g.rows[0]).toEqual({ lane: 0, into: [], through: [], out: [0, 1] });
    expect(g.rows[1].lane).toBe(1);
    expect(g.rows[2].lane).toBe(0);
    expect(g.rows[3].into).toEqual([0, 1]);
  });

  it("draws no line toward a parent the listing was cut before", () => {
    const g = layoutGraph([c("b", "a"), c("a", "gone")]);
    expect(g.rows[1].out).toEqual([]);
  });

  it("reuses a lane once the branch in it has ended", () => {
    const g = layoutGraph([c("x", "base"), c("y", "base"), c("base", "old"), c("z", "old"), c("old")]);
    expect(g.rows[3].lane).toBe(1);
    expect(g.width).toBe(2);
  });
});
