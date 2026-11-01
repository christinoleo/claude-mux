import { describe, expect, it } from "vitest";
import {
  hasWrittenAbove,
  isWritten,
  loadOlderWritten,
  nextWritten,
  writtenIds,
  type OlderSource,
  type WalkPosition,
} from "../../web/src/lib/transcript-walk.js";
import type { TranscriptEntry } from "../../src/transcript/parser.js";

const user = (id: string, extra: Partial<TranscriptEntry> = {}) =>
  ({ kind: "user", id, ts: 0, text: id, ...extra }) as TranscriptEntry;
const reply = (id: string) => ({ kind: "text", id, ts: 0, text: id }) as TranscriptEntry;

describe("isWritten", () => {
  it("counts a prompt the agent saw mid-turn", () => {
    expect(isWritten({ kind: "queued", id: "a", ts: 0, text: "a" })).toBe(true);
  });

  it("counts a prompt and a command that printed nothing", () => {
    expect(isWritten(user("a"))).toBe(true);
    expect(isWritten(user("a", { command: { name: "/plan" } }))).toBe(true);
  });

  it("leaves out what a person did not write here", () => {
    expect(isWritten(reply("a"))).toBe(false);
    expect(isWritten(user("a", { command: { name: "/context", output: "12%" } }))).toBe(false);
    expect(isWritten(user("a", { localOutput: true }))).toBe(false);
    expect(isWritten(user("a", { rewound: true }))).toBe(false);
    expect(isWritten({ kind: "queued", id: "a", ts: 0, text: "a", delivered: true })).toBe(false);
    expect(isWritten({ kind: "queued", id: "a", ts: 0, text: "a", rewound: true })).toBe(false);
  });

  it("keeps the order of the log", () => {
    expect(writtenIds([user("a"), reply("x"), user("b")])).toEqual(["a", "b"]);
  });
});

describe("nextWritten", () => {
  const written = ["a", "b", "c"];
  const tops: Record<string, number> = { a: -900, b: -300, c: 200 };
  const at = (over: Partial<WalkPosition>): WalkPosition => ({
    atBottom: false,
    held: null,
    viewTop: 0,
    topOf: (id) => tops[id] ?? null,
    ...over,
  });

  it("goes to the latest message from the bottom, even one already on screen", () => {
    expect(nextWritten(written, at({ atBottom: true }))).toBe("c");
  });

  it("walks backwards from the message each press landed on", () => {
    // Still pinned at the bottom after the press when a short last turn could
    // not scroll: the held message is what moves the walk on, not its place.
    expect(nextWritten(written, at({ atBottom: true, held: "c" }))).toBe("b");
    expect(nextWritten(written, at({ held: "b" }))).toBe("a");
  });

  it("reports nothing past the oldest message", () => {
    expect(nextWritten(written, at({ held: "a" }))).toBeNull();
    expect(nextWritten([], at({ atBottom: true }))).toBeNull();
  });

  it("starts from the scroll position once the reader has moved by hand", () => {
    expect(nextWritten(written, at({}))).toBe("b");
    expect(nextWritten(written, at({ viewTop: -500 }))).toBe("a");
    expect(nextWritten(written, at({ viewTop: 500 }))).toBe("c");
  });

  it("treats a message starting at the top of the view as already reached", () => {
    expect(nextWritten(written, at({ viewTop: -300 }))).toBe("a");
    expect(nextWritten(written, at({ viewTop: -900 }))).toBeNull();
  });

  it("ignores a held message the page no longer has", () => {
    expect(nextWritten(written, at({ held: "gone", atBottom: true }))).toBe("c");
  });

  it("hasWrittenAbove agrees with nextWritten wherever the reader stands", () => {
    const positions = [
      at({ atBottom: true }),
      at({ atBottom: true, held: "c" }),
      at({ held: "b" }),
      at({ held: "a" }),
      at({ held: "gone" }),
      at({}),
      at({ viewTop: -500 }),
      at({ viewTop: -900 }),
      at({ viewTop: -2000 }),
    ];
    for (const position of positions) {
      expect(hasWrittenAbove(written, position)).toBe(nextWritten(written, position) !== null);
    }
    expect(hasWrittenAbove([], at({ atBottom: true }))).toBe(false);
  });

  it("measures one row at most to say whether the button can act", () => {
    let measured = 0;
    const topOf = (id: string) => {
      measured++;
      return tops[id] ?? null;
    };
    hasWrittenAbove(written, at({ topOf }));
    expect(measured).toBe(1);
  });
});

describe("loadOlderWritten", () => {
  /** A log the source hands over in slices of `page`, newest slice first. */
  function log(all: TranscriptEntry[], held: number, page: number) {
    let first = all.length - held;
    const source: OlderSource = {
      written: () => writtenIds(all.slice(first)),
      firstIndex: () => first,
      loadEarlier: async () => {
        first = Math.max(0, first - page);
      },
    };
    return source;
  }

  it("loads the message right before the oldest one held", async () => {
    const source = log([user("a"), user("b"), reply("x"), user("c")], 1, 2);
    expect(await loadOlderWritten(source)).toEqual({ status: "found", id: "b" });
  });

  it("keeps loading through slices with nothing a person wrote", async () => {
    const source = log(
      [user("a"), reply("1"), reply("2"), reply("3"), reply("4"), user("c")],
      1,
      2,
    );
    expect(await loadOlderWritten(source)).toEqual({ status: "found", id: "a" });
  });

  it("finds the latest message when the page held none", async () => {
    const source = log([user("a"), user("b"), reply("x"), reply("y")], 2, 2);
    expect(await loadOlderWritten(source)).toEqual({ status: "found", id: "b" });
  });

  it("says so when the history runs out", async () => {
    const source = log([reply("x"), reply("y"), user("c")], 1, 2);
    expect(await loadOlderWritten(source)).toEqual({ status: "none" });
    expect(await loadOlderWritten(log([user("c")], 1, 2))).toEqual({ status: "none" });
  });

  it("fails when a slice comes back with nothing", async () => {
    const source: OlderSource = {
      written: () => ["c"],
      firstIndex: () => 40,
      loadEarlier: async () => {},
    };
    expect(await loadOlderWritten(source)).toEqual({ status: "failed" });
  });

  it("fails when a snapshot replaced what the walk was counting from", async () => {
    let first = 40;
    let written = ["c"];
    const source: OlderSource = {
      written: () => written,
      firstIndex: () => first,
      loadEarlier: async () => {
        first = 30;
        written = ["x", "y"];
      },
    };
    expect(await loadOlderWritten(source)).toEqual({ status: "failed" });
  });
});
