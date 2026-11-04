import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const paths = vi.hoisted(() => ({ CLAUDE_DIR: "", CLAUDE_SETTINGS_PATH: "" }));
vi.mock("../../src/utils/paths.js", () => paths);

const { followDialogAnswersPort, readDialogAnswers, setDialogAnswers } = await import("../../src/server/dialog-switch.js");
const { setLiveText } = await import("../../src/server/live-text-switch.js");
const { installHooks, saveClaudeSettings, uninstallHooks } = await import("../../src/setup/hooks.js");

const PROD = { dev: false, port: 3456 };
const hold = (port: number) => ({
  hooks: [{ type: "http", url: `http://127.0.0.1:${port}/api/hooks/dialog`, timeout: 605 }],
});
const ended = (port: number) => ({
  hooks: [
    {
      type: "command",
      command: `curl -s -m 1 -o /dev/null -H 'content-type: application/json' --data-binary @- http://127.0.0.1:${port}/api/hooks/dialog/ended || true`,
      timeout: 2,
    },
  ],
});
const entries = (port: number) => ({
  PermissionRequest: [hold(port)],
  PostToolUse: [ended(port)],
  PostToolUseFailure: [ended(port)],
  Stop: [ended(port)],
});
const OTHERS = {
  model: "opus",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }],
    PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }],
  },
};

let dir: string;
const write = (settings: unknown) => writeFileSync(paths.CLAUDE_SETTINGS_PATH, JSON.stringify(settings));
const read = () => JSON.parse(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-mux-dialog-"));
  paths.CLAUDE_DIR = join(dir, ".claude");
  paths.CLAUDE_SETTINGS_PATH = join(paths.CLAUDE_DIR, "settings.json");
  mkdirSync(paths.CLAUDE_DIR);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the switch", () => {
  it("is off at first", () => {
    write(OTHERS);
    expect(readDialogAnswers(PROD)).toEqual({ enabled: false, switchable: true });
  });

  it("turning on adds its entries beside the others, holding for just past the ten-minute limit", () => {
    write(OTHERS);
    expect(setDialogAnswers(true, PROD)).toBe(true);
    const e = entries(3456);
    expect(read().hooks).toEqual({
      PermissionRequest: [...OTHERS.hooks.PermissionRequest, ...e.PermissionRequest],
      Stop: [...OTHERS.hooks.Stop, ...e.Stop],
      PostToolUse: e.PostToolUse,
      PostToolUseFailure: e.PostToolUseFailure,
    });
    expect(readDialogAnswers(PROD).enabled).toBe(true);
  });

  it("turning off puts the file back as it was", () => {
    write(OTHERS);
    setDialogAnswers(true, PROD);
    setDialogAnswers(false, PROD);
    expect(read()).toEqual(OTHERS);
  });

  it("does not disturb live text, which has a switch of its own", () => {
    setLiveText(true, PROD);
    setDialogAnswers(true, PROD);
    setDialogAnswers(false, PROD);
    expect(Object.keys(read().hooks)).toEqual(["MessageDisplay"]);
  });

  it("does not write on a dev server", () => {
    write(OTHERS);
    const before = readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8");
    expect(setDialogAnswers(true, { dev: true, port: 3434 })).toBe(false);
    expect(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8")).toBe(before);
    expect(readDialogAnswers({ dev: true })).toEqual({ enabled: false, switchable: false });
  });

  it("moves every entry when the server comes up on another port", async () => {
    setDialogAnswers(true, PROD);
    await followDialogAnswersPort({ dev: false, port: 4000 }, async () => false);
    expect(read().hooks).toEqual(entries(4000));
  });

  it("is not taken for setup's own hooks, which it replaces", () => {
    setDialogAnswers(true, PROD);
    saveClaudeSettings(installHooks().newSettings);
    expect(read().hooks.Stop).toContainEqual(ended(3456));
    expect(read().hooks.PostToolUse).toContainEqual(ended(3456));
  });

  it("is not installed by startup while off", async () => {
    write(OTHERS);
    await followDialogAnswersPort(PROD);
    expect(read()).toEqual(OTHERS);
  });
});

describe("setup with the switch on", () => {
  it("keeps the entries beside its own", () => {
    setDialogAnswers(true, PROD);
    saveClaudeSettings(installHooks().newSettings);
    expect(read().hooks.PermissionRequest).toContainEqual(hold(3456));
    expect(read().hooks.PermissionRequest).toHaveLength(2);
    expect(readDialogAnswers(PROD).enabled).toBe(true);
  });

  it("uninstalling takes them out with the rest", () => {
    write(OTHERS);
    saveClaudeSettings(installHooks().newSettings);
    setDialogAnswers(true, PROD);
    uninstallHooks();
    expect(read()).toEqual(OTHERS);
  });
});
