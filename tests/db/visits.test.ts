import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getVisits, recordVisit, markUnread, setVisitsPath } from "../../src/db/visits-json.js";
import { indicatorStateOf, isUnread } from "../../src/session-state.js";

const dir = join(tmpdir(), `claude-mux-visits-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const path = join(dir, "visits.json");

describe("visits watermark (JSON file)", () => {
  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    setVisitsPath(path);
  });
  afterEach(() => {
    setVisitsPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty and remembers a visit", () => {
    expect(getVisits()).toEqual({});
    recordVisit("a", 1_000);
    expect(getVisits()).toEqual({ a: 1_000 });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: 1_000 });
  });

  it("clears an unread completion once visited, and marking unread brings it back", () => {
    const turn = { state: "idle" as const, turn_completed_at: 5_000 };
    recordVisit("a", 4_000);
    expect(isUnread({ ...turn, last_visited_at: getVisits().a })).toBe(true);
    expect(indicatorStateOf({ ...turn, last_visited_at: getVisits().a })).toBe("done");

    recordVisit("a", 6_000);
    expect(isUnread({ ...turn, last_visited_at: getVisits().a })).toBe(false);
    expect(indicatorStateOf({ ...turn, last_visited_at: getVisits().a })).toBe("idle");

    expect(markUnread("a", turn.turn_completed_at)).toBe(true);
    expect(getVisits().a).toBe(4_999);
    expect(isUnread({ ...turn, last_visited_at: getVisits().a })).toBe(true);
  });

  it("has nothing to mark unread before a turn finishes", () => {
    expect(markUnread("a", null)).toBe(false);
    expect(getVisits()).toEqual({});
  });

  it("treats a session nobody ever opened as read", () => {
    expect(isUnread({ state: "idle", turn_completed_at: 5_000, last_visited_at: null })).toBe(false);
  });

  it("shows a working session as working, unread or not", () => {
    expect(indicatorStateOf({ state: "busy", turn_completed_at: 5_000, last_visited_at: 1 })).toBe("busy");
  });

  it("drops month-old visits on the next write, and ignores junk", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeFileSync(path, JSON.stringify({ gone: old, junk: "x" }));
    setVisitsPath(path);
    expect(getVisits()).toEqual({ gone: old });
    recordVisit("b");
    expect(Object.keys(getVisits())).toEqual(["b"]);
  });

  it("keeps the other watermarks when the file turns unreadable", () => {
    const t = Date.now();
    recordVisit("a", t);
    recordVisit("b", t + 1);
    writeFileSync(path, "{cut off");
    recordVisit("c", t + 2);
    expect(getVisits()).toEqual({ a: t, b: t + 1, c: t + 2 });
  });

  it("survives a corrupt file", () => {
    writeFileSync(path, "{not json");
    setVisitsPath(path);
    expect(getVisits()).toEqual({});
    recordVisit("a", 1);
    expect(getVisits()).toEqual({ a: 1 });
  });
});
