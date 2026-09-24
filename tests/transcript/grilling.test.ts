import { describe, it, expect } from "vitest";
import { parseGrillRound, composeGrillReply } from "../../src/transcript/grilling.js";

// The shape the grilling skill prescribes: number, bold title, body, then the
// recommendation on its own line.
const ROUND = `Good — the destination is settled. Next round:

❓ **Q1** - **Storage**: Where should drafts live?

They could sit in the session JSON, or in a file of their own.

➡️ In the session JSON, next to the rest of the live state.

❓ **Q2** - **Sync**: Should a draft follow you to another machine?

➡️ No — drafts are per browser.

❓ **Q3** - **Limits**: How long may a draft be?

➡️ No limit; the pane decides.

Answer these and I'll draw up the next round.`;

describe("parseGrillRound", () => {
  it("reads every question with its title, body and recommendation", () => {
    const round = parseGrillRound(ROUND)!;
    expect(round.intro).toBe("Good — the destination is settled. Next round:");
    expect(round.questions.map((q) => q.n)).toEqual([1, 2, 3]);
    expect(round.questions[0]).toEqual({
      n: 1,
      title: "Storage",
      body: "Where should drafts live?\n\nThey could sit in the session JSON, or in a file of their own.",
      recommended: "In the session JSON, next to the rest of the live state.",
    });
    expect(round.questions[1].recommended).toBe("No — drafts are per browser.");
  });

  it("keeps what follows the last recommendation out of it", () => {
    const round = parseGrillRound(ROUND)!;
    expect(round.questions[2].recommended).toBe("No limit; the pane decides.");
    expect(round.outro).toBe("Answer these and I'll draw up the next round.");
  });

  it("returns null for a reply that asks nothing", () => {
    expect(parseGrillRound("All done. Q1 went fine.")).toBeNull();
  });

  it("takes a title written inside the number's bold", () => {
    const round = parseGrillRound("❓ **Q4 - Naming**: What is it called?\n\n➡️ `inbox`.")!;
    expect(round.questions[0]).toMatchObject({ n: 4, title: "Naming", body: "What is it called?", recommended: "`inbox`." });
  });

  it("allows a question with no title and one with no recommendation", () => {
    const round = parseGrillRound("❓ **Q1** Is this needed at all?\n\n❓ **Q2** - **Scope**: Which repos?\n\n➡️ All of them.")!;
    expect(round.questions[0]).toMatchObject({ title: null, body: "Is this needed at all?", recommended: null });
    expect(round.questions[1]).toMatchObject({ title: "Scope", recommended: "All of them." });
  });

  it("keeps a multi-paragraph recommendation whole when another question follows", () => {
    const round = parseGrillRound("❓ **Q1** - **A**: a?\n\n➡️ Yes.\n\nBecause b.\n\n❓ **Q2** - **B**: b?\n\n➡️ No.")!;
    expect(round.questions[0].recommended).toBe("Yes.\n\nBecause b.");
  });
});

describe("composeGrillReply", () => {
  const round = parseGrillRound(ROUND)!;

  it("writes one line per question, in order", () => {
    const reply = composeGrillReply(round, {
      1: { mode: "accept" },
      2: { mode: "own", text: "Yes, through the server.\n" },
      3: { mode: "skip" },
    });
    expect(reply).toBe(
      [
        "Q1 (Storage): agreed, go with your recommendation.",
        "Q2 (Sync): Yes, through the server.",
        "Q3 (Limits): skip for now, leave it open.",
      ].join("\n")
    );
  });

  it("accepts a recommendation nobody touched, and treats an empty answer as a skip", () => {
    const reply = composeGrillReply(round, { 2: { mode: "own", text: "  " } });
    expect(reply.split("\n")).toEqual([
      "Q1 (Storage): agreed, go with your recommendation.",
      "Q2 (Sync): skip for now, leave it open.",
      "Q3 (Limits): agreed, go with your recommendation.",
    ]);
  });
});
