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
    expect(round.questions.map((q) => q.label)).toEqual(["Q1", "Q2", "Q3"]);
    expect(round.questions[0]).toEqual({
      label: "Q1",
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
    expect(round.questions[0]).toMatchObject({ label: "Q4", title: "Naming", body: "What is it called?", recommended: "`inbox`." });
  });

  it("takes a middle dot inside the bold and rules between questions", () => {
    const round = parseGrillRound(`Rodada 1.

❓ **Q1 · Modo do PostHog**: sem cookies, sem banner.

➡️ Sim: sem cookies.

---

❓ **Q2 · Proxy**: os eventos passam por \`/ingest\`.

➡️ Sim.`)!;
    expect(round.questions.map((q) => [q.label, q.title, q.recommended])).toEqual([
      ["Q1", "Modo do PostHog", "Sim: sem cookies."],
      ["Q2", "Proxy", "Sim."],
    ]);
    expect(round.questions[0].body).toBe("sem cookies, sem banner.");
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

describe("parseGrillRound labels", () => {
  it.each([
    ["❓ **Q3b - Naming**: What is it called?", "Q3b", "Naming", "What is it called?"],
    ["❓ **Q2 de novo - Naming**: What is it called?", "Q2 de novo", "Naming", "What is it called?"],
    ["❓ **Q17, última vez - Naming**: What is it called?", "Q17, última vez", "Naming", "What is it called?"],
    ["❓ **Q17 de novo - Naming** (asked twice now): What is it called?", "Q17 de novo", "Naming", "(asked twice now): What is it called?"],
    ["❓ **Q3b** - **Naming**: What is it called?", "Q3b", "Naming", "What is it called?"],
    ["❓ **Q2 de novo**: What is it called?", "Q2 de novo", null, "What is it called?"],
    ["❓ **Q3b:** What is it called?", "Q3b", null, "What is it called?"],
    ["❓ **Q3b:** **Naming**: What is it called?", "Q3b", "Naming", "What is it called?"],
    ["❓ **Q2 re-asked - Naming**: What is it called?", "Q2 re-asked", "Naming", "What is it called?"],
  ])("reads %s", (line, label, title, body) => {
    expect(parseGrillRound(line)!.questions).toEqual([{ label, title, body, recommended: null }]);
  });

  it("leaves nothing out when a reply mixes plain and suffixed questions", () => {
    const round = parseGrillRound(`Round three.

❓ **Q1** - **Storage**: Where?

➡️ Here.

❓ **Q2 de novo - Sync**: Still no?

➡️ Still no.

❓ **Q3b - Limits**: How long?

➡️ No limit.

❓ **Q4 · Names**: Which?

➡️ Short ones.

Over to you.`)!;
    expect(round.intro).toBe("Round three.");
    expect(round.outro).toBe("Over to you.");
    expect(round.questions.map((q) => [q.label, q.title, q.recommended])).toEqual([
      ["Q1", "Storage", "Here."],
      ["Q2 de novo", "Sync", "Still no."],
      ["Q3b", "Limits", "No limit."],
      ["Q4", "Names", "Short ones."],
    ]);
  });

  it("does not take a long bold sentence for a label, and reads it quickly", () => {
    expect(parseGrillRound(`❓ **Q1 ${"a - ".repeat(10000)}`)).toBeNull();
    expect(parseGrillRound(`❓ **Q1 ${"word ".repeat(20)}**: body`)).toBeNull();
  });

  it("keeps a line it cannot read visible as text", () => {
    const round = parseGrillRound("❓ **Q1 - A**: a?\n\n➡️ Yes.\n\n❓ And one more thing, unnumbered?")!;
    expect(round.questions.map((q) => q.label)).toEqual(["Q1"]);
    expect(round.outro).toBe("❓ And one more thing, unnumbered?");
    expect(parseGrillRound("❓ **Question for you**: anything else?")).toBeNull();
    expect(parseGrillRound("❓ **Q2x9 - A**: a?")).toBeNull();
  });
});

describe("composeGrillReply", () => {
  const round = parseGrillRound(ROUND)!;

  it("writes one line per question, in order", () => {
    const reply = composeGrillReply(round, {
      Q1: { mode: "accept" },
      Q2: { mode: "own", text: "Yes, through the server.\n" },
      Q3: { mode: "skip" },
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
    const reply = composeGrillReply(round, { Q2: { mode: "own", text: "  " } });
    expect(reply.split("\n")).toEqual([
      "Q1 (Storage): agreed, go with your recommendation.",
      "Q2 (Sync): skip for now, leave it open.",
      "Q3 (Limits): agreed, go with your recommendation.",
    ]);
  });

  it("quotes each label as written and keeps Q3 apart from Q3b", () => {
    const suffixed = parseGrillRound(`❓ **Q3 - Limits**: How long?

➡️ No limit.

❓ **Q3b - Limits again**: How wide?

➡️ No limit either.

❓ **Q2 de novo - Sync**: Still no?

➡️ Still no.

❓ **Q17, última vez**: Sure?`)!;
    const reply = composeGrillReply(suffixed, {
      Q3b: { mode: "own", text: "80 columns." },
      "Q17, última vez": { mode: "own", text: "Yes." },
    });
    expect(reply.split("\n")).toEqual([
      "Q3 (Limits): agreed, go with your recommendation.",
      "Q3b (Limits again): 80 columns.",
      "Q2 de novo (Sync): agreed, go with your recommendation.",
      "Q17, última vez: Yes.",
    ]);
  });
});
