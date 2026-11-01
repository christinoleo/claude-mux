import { describe, expect, it } from "vitest";
import { CUT_OFF_KEEP_MS, LiveTextStore, type LiveBatch } from "../../src/transcript/live-text.js";

const S = "session";

function batch(message_id: string, index: number, delta: string, final = false): LiveBatch {
  return { session_id: S, message_id, index, delta, final };
}

function texts(store: LiveTextStore): string[] {
  return store.view(S).map((m) => m.text);
}

/** Replay what a reader is sent, to prove the pieces add up to the view. */
function apply(held: string, piece: { start: number; text: string } | null): string {
  return piece ? held.slice(0, piece.start) + piece.text : held;
}

describe("LiveTextStore", () => {
  it("holds a message's batches in index order, however they arrive", () => {
    const store = new LiveTextStore();
    let held = "";
    held = apply(held, store.accept(batch("m", 0, "one\n"), 1));
    held = apply(held, store.accept(batch("m", 2, "three\n"), 2));
    held = apply(held, store.accept(batch("m", 1, "two\n"), 3));
    expect(texts(store)).toEqual(["one\ntwo\nthree\n"]);
    expect(held).toBe("one\ntwo\nthree\n");
  });

  it("ignores a batch it already has", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one\n"), 1);
    expect(store.accept(batch("m", 0, "one\n"), 2)).toBeNull();
    expect(texts(store)).toEqual(["one\n"]);
  });

  it("gives a late reader the accumulated text and later batches continue it", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one\n"), 1);
    store.accept(batch("m", 1, "two\n"), 2);
    let held = store.view(S)[0].text;
    expect(held).toBe("one\ntwo\n");
    held = apply(held, store.accept(batch("m", 2, "three\n"), 3));
    expect(held).toBe("one\ntwo\nthree\n");
  });

  it("is replaced by an entry it is a prefix of, oldest first", () => {
    const store = new LiveTextStore();
    store.accept(batch("a", 0, "same\n"), 1);
    store.accept(batch("b", 0, "same\n"), 2);
    expect(store.land(S, "same\nand more", 10)).toBe(true);
    expect(store.view(S).map((m) => m.id)).toEqual(["b"]);
  });

  it("falls back to order when a lost batch left a hole", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one\n"), 1);
    store.accept(batch("m", 2, "three\n", true), 2);
    expect(store.land(S, "one\ntwo\nthree", 10)).toBe(true);
    expect(texts(store)).toEqual([]);
  });

  it("falls back to order when the first batch was lost", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 1, "two\n"), 1);
    expect(store.land(S, "one\ntwo\nthree", 10)).toBe(true);
    expect(texts(store)).toEqual([]);
  });

  it("leaves text still streaming alone when an unrelated entry lands", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "writing\n"), 1);
    expect(store.land(S, "No response requested.", 10)).toBe(false);
    expect(texts(store)).toEqual(["writing\n"]);
  });

  it("marks older text cut off on a new message, and the entry still replaces it", () => {
    const store = new LiveTextStore();
    store.accept(batch("old", 0, "L050\n"), 1);
    store.accept(batch("new", 0, "fresh\n"), 2);
    expect(store.land(S, "L050\nL051 alpha beta", 10)).toBe(true);
    expect(store.view(S).map((m) => m.id)).toEqual(["new"]);
  });

  it("discards text 60s after a new message cut it off, not before", () => {
    const store = new LiveTextStore();
    store.accept(batch("old", 0, "gone\n"), 0);
    store.accept(batch("new", 0, "stays\n"), 1000);
    expect(store.expire(S, 1000 + CUT_OFF_KEEP_MS - 1)).toBe(false);
    expect(texts(store)).toEqual(["gone\n", "stays\n"]);
    expect(store.expire(S, 1000 + CUT_OFF_KEEP_MS)).toBe(true);
    expect(texts(store)).toEqual(["stays\n"]);
  });

  it("discards text 60s after a prompt cut it off", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "esc\n"), 0);
    store.promptSubmitted(S, 500);
    expect(store.expire(S, 500 + CUT_OFF_KEEP_MS)).toBe(true);
    expect(store.holds(S)).toBe(false);
  });

  it("does not take a prompt queued mid-reply for the end of it", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one\n"), 0);
    store.promptSubmitted(S, 500);
    store.accept(batch("m", 1, "two\n"), 600);
    expect(store.expire(S, 600 + CUT_OFF_KEEP_MS)).toBe(false);
    expect(texts(store)).toEqual(["one\ntwo\n"]);
  });

  it("holds an unfinished message with no prompt or new message after it", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "waiting\n"), 0);
    expect(store.expire(S, 10 * CUT_OFF_KEEP_MS)).toBe(false);
    expect(texts(store)).toEqual(["waiting\n"]);
  });

  it("forgets a finished message nobody read once its entry must be on disk", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "done", true), 0);
    expect(store.expire(S, CUT_OFF_KEEP_MS - 1)).toBe(false);
    expect(store.expire(S, CUT_OFF_KEEP_MS)).toBe(true);
    expect(store.holds(S)).toBe(false);
  });

  it("is not uncut by a call that was still in flight when a newer message began", () => {
    const store = new LiveTextStore();
    store.accept(batch("old", 0, "gone\n"), 0);
    store.accept(batch("new", 0, "stays\n"), 1000);
    store.accept(batch("old", 1, "late\n"), 1100);
    expect(store.expire(S, 1000 + CUT_OFF_KEEP_MS)).toBe(true);
    expect(texts(store)).toEqual(["stays\n"]);
  });

  it("lets an entry that beat its batch take that batch when it comes", () => {
    const store = new LiveTextStore();
    expect(store.land(S, "one line", 0)).toBe(false);
    expect(store.accept(batch("m", 0, "one line", true), 100)).toBeNull();
    expect(texts(store)).toEqual([]);
  });

  it("lets an unclaimed entry take a new message it begins with, leaving others alone", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "writing\n"), 0);
    expect(store.land(S, "two\nlines", 10)).toBe(false);
    expect(store.accept(batch("n", 0, "two\n"), 20)).toBeNull();
    expect(texts(store)).toEqual(["writing\n"]);
  });

  it("does not let an old unclaimed entry take a new message", () => {
    const store = new LiveTextStore();
    store.land(S, "same", 0);
    expect(store.accept(batch("m", 0, "same", true), 6000)).toEqual({ start: 0, text: "same" });
  });

  it("matches past leading whitespace the record dropped", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "\n\nHello\n"), 1);
    expect(store.land(S, "Hello there", 10)).toBe(true);
    expect(texts(store)).toEqual([]);
  });

  it("leaves nothing behind when only the live text has leading whitespace", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "\nHello there.\n"), 1);
    expect(store.land(S, "Hello there.", 10)).toBe(true);
    expect(texts(store)).toEqual([]);
  });

  it("keeps the next block whole when only the entry has leading whitespace", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "Hello\n"), 1);
    expect(store.land(S, "\n\nHello\n", 10)).toBe(true);
    store.accept(batch("m", 1, "Second block\n"), 2);
    expect(texts(store)).toEqual(["Second block\n"]);
  });

  it("discards everything when the session dies", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one\n"), 0);
    expect(store.drop(S)).toBe(true);
    expect(store.holds(S)).toBe(false);
    expect(store.drop(S)).toBe(false);
  });

  it("keeps the rest of a message with two text blocks until its second entry lands", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "first block\n"), 1);
    store.accept(batch("m", 1, "first ends.second block\n"), 2);
    store.accept(batch("m", 2, "second ends.", true), 3);
    expect(store.land(S, "first block\nfirst ends.", 10)).toBe(true);
    expect(texts(store)).toEqual(["second block\nsecond ends."]);
    expect(store.land(S, "second block\nsecond ends.", 10)).toBe(true);
    expect(texts(store)).toEqual([]);
  });

  it("keeps a second block's batches that arrive after the first block's entry", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "first\n"), 1);
    expect(store.land(S, "first\n", 10)).toBe(true);
    let held = "";
    held = apply(held, store.accept(batch("m", 1, "second\n"), 2));
    expect(held).toBe("second\n");
    expect(texts(store)).toEqual(["second\n"]);
  });

  it("keeps a straggler behind its own entry hidden", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one\n"), 1);
    expect(store.land(S, "one\ntwo\nthree", 10)).toBe(true);
    expect(store.accept(batch("m", 1, "two\n"), 2)).toBeNull();
    expect(texts(store)).toEqual([]);
  });

  it("forgets a message the record has taken once no straggler can arrive", () => {
    const store = new LiveTextStore();
    store.accept(batch("m", 0, "one", true), 0);
    store.land(S, "one", 10);
    expect(store.expire(S, 1000)).toBe(false);
    expect(store.holds(S)).toBe(true);
    expect(store.expire(S, 5000)).toBe(false);
    expect(store.holds(S)).toBe(false);
  });

  it("does nothing when an entry lands with no live text held", () => {
    expect(new LiveTextStore().land(S, "anything", 10)).toBe(false);
  });
});
