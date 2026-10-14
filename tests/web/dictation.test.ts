import { describe, it, expect } from "vitest";
import { insertSaid } from "../../web/src/lib/dictation.js";

const at = (n: number) => ({ start: n, end: n });

describe("insertSaid", () => {
  it("goes in at the caret between two words, with the caret after it", () => {
    expect(insertSaid("hello world", "big", at(5))).toEqual({ text: "hello big world", caret: 9 });
    expect(insertSaid("hello world", "big", at(6))).toEqual({ text: "hello big world", caret: 9 });
  });

  it("replaces a selection", () => {
    expect(insertSaid("hello cruel world", "big", { start: 6, end: 11 })).toEqual({
      text: "hello big world",
      caret: 9,
    });
  });

  it("adds a space after the words at the start of the text", () => {
    expect(insertSaid("world", "hello", at(0))).toEqual({ text: "hello world", caret: 5 });
  });

  it("adds no space before punctuation", () => {
    expect(insertSaid("hello.", "world", at(5))).toEqual({ text: "hello world.", caret: 11 });
    expect(insertSaid("(hello)", "there", at(6)).text).toBe("(hello there)");
  });

  it("spaces off a straight quote, which may open a quotation", () => {
    expect(insertSaid('say "hi"', "big", at(4)).text).toBe('say big "hi"');
  });

  it("adds no space where whitespace already sits", () => {
    expect(insertSaid("hello \nworld", "big", at(6)).text).toBe("hello big\nworld");
  });

  it("keeps a second take going from where the first ended", () => {
    const first = insertSaid("hello world", "big", at(5));
    expect(insertSaid(first.text, "wide", at(first.caret)).text).toBe("hello big wide world");
  });

  it("appends the way it always has with no caret, or with the caret at the end", () => {
    for (const spot of [null, at(8), at(99)]) {
      expect(insertSaid("hello  \n", "world", spot)).toEqual({ text: "hello world", caret: 11 });
    }
    expect(insertSaid("hello", "world", null).text).toBe("hello world");
  });

  it("takes the words alone in an empty or blank field", () => {
    expect(insertSaid("", "hello", null)).toEqual({ text: "hello", caret: 5 });
    expect(insertSaid("   ", "hello", at(1)).text).toBe("hello");
  });
});
