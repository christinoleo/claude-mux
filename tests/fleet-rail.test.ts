import { describe, expect, it } from "vitest";
import { dropBefore, MACHINE_COLORS, machineMarks, matchesQuery, moveTile, railOrder, railShown, sessionToOpen } from "../src/fleet-rail.js";

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

describe("railShown", () => {
  const tiles = [
    { key: "busy", running: true },
    { key: "idle", running: false },
    { key: "worker", running: true },
    { key: "quiet", running: false }
  ];
  const keys = (list: { key: string }[]) => list.map((t) => t.key);

  it("shows every project while the toggle is off", () => {
    expect(keys(railShown(tiles, false, new Set()))).toEqual(["busy", "idle", "worker", "quiet"]);
  });

  it("hides the projects with no live session, keeping the rail's order", () => {
    expect(keys(railShown(tiles, true, new Set()))).toEqual(["busy", "worker"]);
  });

  it("brings a project back once it gains a session", () => {
    const after = railShown(
      tiles.map((t) => (t.key === "idle" ? { ...t, running: true } : t)),
      true,
      new Set()
    );
    expect(keys(after)).toEqual(["busy", "idle", "worker"]);
  });

  it("never hides the project of the session on screen", () => {
    expect(keys(railShown(tiles, true, new Set(["quiet"])))).toEqual(["busy", "worker", "quiet"]);
  });
});

describe("dropBefore with hidden projects", () => {
  // The rail is A, B, C, D; A and C are idle and hidden, so B and D are drawn.
  const all = ["A", "B", "C", "D"];
  const drawn = ["B", "D"];

  it("keeps hidden projects in their places when a drawn tile moves", () => {
    const next = moveTile(all, all, "D", dropBefore(all, drawn, "B"));
    expect(next).toEqual(["A", "D", "B", "C"]);
  });

  it("puts a tile dropped at the end of the drawn rail after the last drawn tile, not past hidden ones", () => {
    const next = moveTile(all, all, "B", dropBefore(all, drawn, null));
    expect(next).toEqual(["A", "C", "D", "B"]);
    expect(dropBefore(["A", "B", "C", "D", "E"], ["B", "C"], null)).toBe("D");
  });

  it("leaves a drop before a drawn tile alone", () => {
    expect(dropBefore(all, drawn, "D")).toBe("D");
  });
});

describe("sessionToOpen", () => {
  const c = (item: string, wants: boolean, lastUpdate: number, lastVisited: number | null = null) => ({
    item,
    wants,
    lastUpdate,
    lastVisited,
  });

  it("opens the session waiting on a person longest", () => {
    expect(sessionToOpen([c("busy", false, 500, 900), c("new-ask", true, 300), c("old-ask", true, 100), c("x", false, 50)])).toBe(
      "old-ask",
    );
  });

  it("else the one opened last", () => {
    expect(sessionToOpen([c("a", false, 900, 100), c("b", false, 200, 400), c("never", false, 1000)])).toBe("b");
  });

  it("else the one that changed last", () => {
    expect(sessionToOpen([c("a", false, 100), c("b", false, 300), c("c", false, 200)])).toBe("b");
  });

  it("opens nothing in a project with no live session", () => {
    expect(sessionToOpen([])).toBeNull();
  });

  it("opens nothing when the session on screen already belongs to the project", () => {
    expect(sessionToOpen([c("ask", true, 100), c("other", false, 200, 300)], true)).toBeNull();
  });
});
