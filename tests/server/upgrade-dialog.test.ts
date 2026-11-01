import { describe, expect, it, vi } from "vitest";

const LOCAL_DIALOG = [" Select model", " ❯ 1. Default", "   2. Sonnet", "", " Enter to confirm · Esc to exit"].join("\n");
let state = "idle";
let screen = "";
const typed: string[][] = [];

vi.mock("../../src/tmux/pane.js", async (original) => ({
  ...(await original<typeof import("../../src/tmux/pane.js")>()),
  capturePaneContentAsync: vi.fn(async () => screen),
  readUpdateNotice: vi.fn(() => ({ command: "mise upgrade claude" })),
  runTmux: vi.fn(async (args: string[]) => {
    typed.push(args);
    return "";
  }),
}));

vi.mock("../../src/db/sessions-json.js", async (original) => ({
  ...(await original<typeof import("../../src/db/sessions-json.js")>()),
  getSession: vi.fn(() => ({ state })),
}));

const { upgradeThenRestart } = await import("../../src/server/restart-claude.js");

describe("upgradeThenRestart", () => {
  const session = { id: "s", pid: 0, cwd: "/", tmux_target: "main:1.0", state: "idle" } as never;

  it("types nothing into a local command's dialog, which leaves the session idle", async () => {
    screen = LOCAL_DIALOG;
    expect(await upgradeThenRestart(session)).toEqual({ ok: false, error: "Answer the open dialog first" });
    expect(typed).toEqual([]);
  });

  it("types nothing into a dialog that opened since the caller read the session", async () => {
    screen = "";
    state = "permission";
    expect(await upgradeThenRestart(session)).toEqual({ ok: false, error: "Answer the open dialog first" });
    expect(typed).toEqual([]);
  });
});
