import { describe, expect, it } from "vitest";
import { shellLoginToLogin, type PaneIo } from "../../src/server/shell-login.js";

const RULE = "─".repeat(60);

/** `! claude auth login` waiting on its code, with the box empty below it. */
const RUNNING = [
  "! claude auth login",
  "  ⎿  If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc",
  "     Paste code here if prompted >",
  "     (4s)",
  "     (ctrl+b ctrl+b (twice) to run in background)",
  RULE,
  "❯ ",
  RULE,
].join("\n");

/** Stopped: the output gone and the command handed back to the box, in shell mode. */
const STOPPED = ["● Done.", RULE, "! claude auth login", RULE, "  ! for shell mode"].join("\n");
const EMPTIED = ["● Done.", RULE, "! ", RULE, "  ! for shell mode"].join("\n");
const CLEAR = ["● Done.", RULE, "❯ ", RULE].join("\n");

/** A pane whose screen follows the keys it has been sent, and records what it was sent. */
function fakePane(react: (sent: string[]) => string): PaneIo & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    read: async () => react(sent),
    keys: async (...names) => void sent.push(...names),
    type: async (text) => void sent.push(`text:${text}`),
  };
}

describe("shellLoginToLogin", () => {
  it("stops the command, empties the box and leaves shell mode, then runs /login", async () => {
    const pane = fakePane((sent) => {
      if (!sent.includes("Escape")) return RUNNING;
      if (!sent.includes("C-u")) return STOPPED;
      return sent.includes("BSpace") ? CLEAR : EMPTIED;
    });
    expect(await shellLoginToLogin(pane, 1)).toEqual({ ok: true });
    expect(pane.sent).toEqual(["Escape", "C-u", "BSpace", "text:/login", "Enter"]);
  });

  it("types nothing while the command keeps running", async () => {
    const pane = fakePane(() => RUNNING);
    const result = await shellLoginToLogin(pane, 1);
    expect(result.ok).toBe(false);
    expect(pane.sent).toEqual(["Escape"]);
  });

  it("does not type /login behind text left in the box", async () => {
    const pane = fakePane((sent) => (sent.includes("Escape") ? STOPPED : RUNNING));
    const result = await shellLoginToLogin(pane, 1);
    expect(result.ok).toBe(false);
    expect(pane.sent).not.toContain("text:/login");
  });

  it("sends nothing to a pane with no shell sign-in", async () => {
    const pane = fakePane(() => CLEAR);
    expect((await shellLoginToLogin(pane, 1)).ok).toBe(false);
    expect(pane.sent).toEqual([]);
  });
});
