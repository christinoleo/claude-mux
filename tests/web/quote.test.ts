import { describe, it, expect } from "vitest";
import { appendQuote, quoteBlock } from "../../web/src/lib/quote.js";

describe("quoteBlock", () => {
  it("puts a quote mark on each line", () => {
    expect(quoteBlock("first line\nsecond line")).toBe("> first line\n> second line");
  });

  it("keeps a paragraph break as a bare mark, and folds a longer gap to one", () => {
    expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two");
    expect(quoteBlock("one\n\n \n\t\ntwo")).toBe("> one\n>\n> two");
  });

  it("drops the blank lines around a selection and the spaces a line ends on", () => {
    expect(quoteBlock("\n \nfirst  \nlast\n\n")).toBe("> first\n> last");
    expect(quoteBlock("a\r\nb\rc")).toBe("> a\n> b\n> c");
  });

  it("keeps the first line's indentation, so code selected from its margin stays aligned", () => {
    expect(quoteBlock("\n    foo();\n    bar();\n")).toBe(">     foo();\n>     bar();");
  });

  it("keeps the indentation of code", () => {
    expect(quoteBlock("if (x) {\n  y();\n}")).toBe("> if (x) {\n>   y();\n> }");
  });

  it("is empty for a selection of nothing", () => {
    expect(quoteBlock("")).toBe("");
    expect(quoteBlock(" \n\t\n")).toBe("");
  });
});

describe("appendQuote", () => {
  it("starts an empty draft with the quote and a blank line to reply on", () => {
    expect(appendQuote("", "two\nlines")).toBe("> two\n> lines\n\n");
  });

  it("keeps what was typed, a blank line above the quote", () => {
    expect(appendQuote("About this:", "the reply")).toBe("About this:\n\n> the reply\n\n");
    expect(appendQuote("About this:\n", "the reply")).toBe("About this:\n\n> the reply\n\n");
  });

  it("stacks a second quote under the first", () => {
    const once = appendQuote("", "one");
    expect(appendQuote(once, "two")).toBe("> one\n\n> two\n\n");
  });

  it("leaves the draft alone when nothing was selected", () => {
    expect(appendQuote("half a thought ", "  \n")).toBe("half a thought ");
  });
});
