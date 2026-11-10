import { describe, expect, it } from "vitest";
import { composeAnswers } from "../../web/src/lib/hold-answer.js";

const SHAPE = { header: "Shape", question: "Which shape?", multiSelect: false, options: [{ label: "Circle" }, { label: "Square" }] };
const COLOURS = { header: "Colour", question: "Which colours?", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] };

describe("composing a question card's answer", () => {
  it("sends a picked option alone", () => {
    expect(composeAnswers([SHAPE], { "Which shape?": ["Square"] }, {})).toEqual({
      answers: { "Which shape?": "Square" },
      annotations: {},
    });
  });

  it("sends a person's own words as the answer when nothing is picked", () => {
    expect(composeAnswers([SHAPE], {}, { "Which shape?": "  a hexagon " })).toEqual({
      answers: { "Which shape?": "a hexagon" },
      annotations: {},
    });
  });

  it("keeps the pick and sends words typed beside it as a note on it", () => {
    expect(composeAnswers([SHAPE], { "Which shape?": ["Square"] }, { "Which shape?": "with round corners" })).toEqual({
      answers: { "Which shape?": "Square" },
      annotations: { "Which shape?": { notes: "with round corners" } },
    });
  });

  it("sends several picks with a note on them", () => {
    expect(
      composeAnswers([SHAPE, COLOURS], { "Which shape?": ["Circle"], "Which colours?": ["Red", "Blue"] }, { "Which colours?": "Red on top" }),
    ).toEqual({
      answers: { "Which shape?": "Circle", "Which colours?": "Red, Blue" },
      annotations: { "Which colours?": { notes: "Red on top" } },
    });
  });

  it("leaves out a question with neither a pick nor words, and blank words", () => {
    expect(composeAnswers([SHAPE, COLOURS], { "Which colours?": [] }, { "Which shape?": "   " })).toEqual({
      answers: {},
      annotations: {},
    });
  });
});
