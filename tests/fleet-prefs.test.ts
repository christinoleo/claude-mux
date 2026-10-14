import { describe, expect, it } from "vitest";
import { isLater, machineFoldKey, mergePrefs, projectFoldKey, type FleetPrefs } from "../src/fleet-prefs.js";

const entry = (value: unknown, at: number, by = "omarchy") => ({ value, at, by });

describe("mergePrefs", () => {
  it("takes the later write of each key and names what changed", () => {
    const mine: FleetPrefs = { a: entry(1, 100), b: entry("x", 300) };
    const { prefs, changed } = mergePrefs(mine, { a: entry(2, 200, "engage"), b: entry("y", 250, "engage") });
    expect(prefs).toEqual({ a: entry(2, 200, "engage"), b: entry("x", 300) });
    expect(changed).toEqual(["a"]);
  });

  it("adds keys it did not have and leaves the original untouched", () => {
    const mine: FleetPrefs = {};
    const { prefs, changed } = mergePrefs(mine, { k: entry(true, 1) });
    expect(prefs).toEqual({ k: entry(true, 1) });
    expect(changed).toEqual(["k"]);
    expect(mine).toEqual({});
  });

  it("returns the same set when nothing is newer", () => {
    const mine: FleetPrefs = { a: entry(1, 100) };
    const result = mergePrefs(mine, { a: entry(1, 100) });
    expect(result.prefs).toBe(mine);
    expect(result.changed).toEqual([]);
  });

  it("breaks a tie on the time by machine id, the same way on every machine", () => {
    const a = entry("from-a", 500, "aaa");
    const b = entry("from-b", 500, "bbb");
    expect(mergePrefs({ k: a }, { k: b }).prefs.k).toEqual(b);
    expect(mergePrefs({ k: b }, { k: a }).prefs.k).toEqual(b);
    expect(isLater(b, a)).toBe(true);
    expect(isLater(a, b)).toBe(false);
  });

  it("converges whatever order the sets arrive in", () => {
    const sets: FleetPrefs[] = [
      { fold: entry(true, 10, "omarchy"), filter: entry("all", 5, "omarchy") },
      { fold: entry(false, 20, "engage") },
      { filter: entry("engage-id", 30, "distilo"), fold: entry(true, 15, "distilo") },
    ];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
    ];
    const results = orders.map((order) => order.reduce<FleetPrefs>((acc, i) => mergePrefs(acc, sets[i]).prefs, {}));
    for (const r of results) {
      expect(r).toEqual({ fold: entry(false, 20, "engage"), filter: entry("engage-id", 30, "distilo") });
    }
  });

  it("skips what is not a well-formed entry", () => {
    const { prefs } = mergePrefs({}, {
      ok: entry(1, 1),
      noTime: { value: 1, by: "x" },
      noValue: { at: 1, by: "x" },
      nan: { value: 1, at: Number.NaN, by: "x" },
      flat: 3,
      ["x".repeat(2000)]: entry(1, 1),
    });
    expect(Object.keys(prefs)).toEqual(["ok"]);
    expect(mergePrefs({}, null).prefs).toEqual({});
    expect(mergePrefs({}, [entry(1, 1)]).prefs).toEqual({});
  });
});

describe("keys", () => {
  it("name a machine's fold by id and a project's by machine and folder", () => {
    expect(machineFoldKey("m1")).toBe("fold:machine:m1");
    expect(projectFoldKey("m1", "/home/leo/Projects/x")).toBe("fold:project:m1:/home/leo/Projects/x");
  });
});
