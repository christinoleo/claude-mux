import { describe, expect, it } from "vitest";
import { MACHINE_COLORS, machineMarks, matchesQuery, moveTile, railOrder } from "../src/fleet-rail.js";

describe("railOrder", () => {
  it("keeps the saved order", () => {
    expect(railOrder(["c", "a", "b"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("puts a project the saved order has never seen at the top", () => {
    expect(railOrder(["c", "a", "b"], ["a", "b", "c", "new"])).toEqual(["new", "c", "a", "b"]);
  });

  it("puts several new projects at the top in the order given", () => {
    expect(railOrder(["a"], ["x", "a", "y"])).toEqual(["x", "y", "a"]);
  });

  it("leaves out saved projects that are not on the rail now", () => {
    expect(railOrder(["gone", "b", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });

  it("takes the given order when nothing is saved, or what is saved is not a list", () => {
    expect(railOrder(undefined, ["a", "b"])).toEqual(["a", "b"]);
    expect(railOrder({ a: 1 }, ["a", "b"])).toEqual(["a", "b"]);
    expect(railOrder(["a", 3, null, "b"], ["b", "a"])).toEqual(["a", "b"]);
  });

  it("does not move a project as its activity changes: the order depends on keys alone", () => {
    const saved = ["b", "a", "c"];
    expect(railOrder(saved, ["c", "b", "a"])).toEqual(railOrder(saved, ["a", "b", "c"]));
  });
});

describe("moveTile", () => {
  const shown = ["a", "b", "c", "d"];

  it("moves a tile up, before the one it is dropped on", () => {
    expect(moveTile(shown, shown, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("moves a tile down, before the one it is dropped on", () => {
    expect(moveTile(shown, shown, "a", "c")).toEqual(["b", "a", "c", "d"]);
  });

  it("moves a tile to the end when dropped past the last", () => {
    expect(moveTile(shown, shown, "b", null)).toEqual(["a", "c", "d", "b"]);
  });

  it("changes nothing when a tile is dropped on itself", () => {
    expect(moveTile(shown, shown, "c", "c")).toEqual(shown);
  });

  it("saves the new projects shown at the top, so they stay where they were dropped", () => {
    const drawn = railOrder(["a", "b"], ["a", "b", "new"]);
    const saved = moveTile(["a", "b"], drawn, "a", "new");
    expect(saved).toEqual(["a", "new", "b"]);
    expect(railOrder(saved, ["a", "b", "new"])).toEqual(["a", "new", "b"]);
  });

  it("keeps saved projects that are not drawn now, so they return to their place", () => {
    const saved = moveTile(["a", "away", "b", "c"], ["a", "b", "c"], "c", "a");
    expect(saved).toEqual(["c", "a", "b", "away"]);
    expect(railOrder(saved, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });
});

describe("matchesQuery", () => {
  it("matches any field, ignoring case", () => {
    expect(matchesQuery("MUX", ["claude-mux", "omarchy"])).toBe(true);
    expect(matchesQuery("engage", ["claude-mux", "omarchy"])).toBe(false);
  });

  it("finds an issue by its number, with or without the #", () => {
    expect(matchesQuery("#100", ["worker", 100])).toBe(true);
    expect(matchesQuery("100", ["worker", 100])).toBe(true);
  });

  it("matches everything when nothing is typed, and skips empty fields", () => {
    expect(matchesQuery("  ", [])).toBe(true);
    expect(matchesQuery("x", [null, undefined])).toBe(false);
  });
});

describe("machineMarks", () => {
  it("gives each machine its first letter and a colour of its own, by id", () => {
    const marks = machineMarks([
      { id: "b", name: "omarchy" },
      { id: "a", name: "engage" },
      { id: "c", name: "distilo" },
    ]);
    expect(marks.get("a")).toEqual({ name: "engage", letter: "E", color: MACHINE_COLORS[0] });
    expect(marks.get("b")).toEqual({ name: "omarchy", letter: "O", color: MACHINE_COLORS[1] });
    expect(marks.get("c")).toEqual({ name: "distilo", letter: "D", color: MACHINE_COLORS[2] });
  });

  it("is the same whatever order the machines arrive in", () => {
    const one = machineMarks([{ id: "x", name: "omarchy" }, { id: "y", name: "engage" }]);
    const two = machineMarks([{ id: "y", name: "engage" }, { id: "x", name: "omarchy" }]);
    expect(one).toEqual(two);
  });

  it("uses two letters where machines share their first", () => {
    const marks = machineMarks([{ id: "a", name: "engage" }, { id: "b", name: "eagle" }]);
    expect(marks.get("a")!.letter).toBe("En");
    expect(marks.get("b")!.letter).toBe("Ea");
  });
});
