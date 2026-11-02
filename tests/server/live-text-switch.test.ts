import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const paths = vi.hoisted(() => ({ CLAUDE_DIR: "", CLAUDE_SETTINGS_PATH: "" }));
vi.mock("../../src/utils/paths.js", () => paths);

const { followLiveTextPort, readLiveText, setLiveText } = await import("../../src/server/live-text-switch.js");
const { checkHooksStatus, installHooks, saveClaudeSettings, uninstallHooks } = await import("../../src/setup/hooks.js");

const PROD = { dev: false, port: 3456 };
const DEV = { dev: true, port: 3434 };
const entry = (port: number) => ({
  hooks: [{ type: "http", url: `http://127.0.0.1:${port}/api/hooks/message-display`, timeout: 1 }],
});
const OTHERS = {
  model: "opus",
  permissions: { allow: ["Bash(ls)"] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "http", url: "https://example.com/audit" }] }],
  },
};

let dir: string;
const write = (settings: unknown) => writeFileSync(paths.CLAUDE_SETTINGS_PATH, JSON.stringify(settings));
const read = () => JSON.parse(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-mux-live-text-"));
  paths.CLAUDE_DIR = join(dir, ".claude");
  paths.CLAUDE_SETTINGS_PATH = join(paths.CLAUDE_DIR, "settings.json");
  mkdirSync(paths.CLAUDE_DIR);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the switch", () => {
  it("is off where nothing has turned it on", () => {
    expect(readLiveText(PROD)).toEqual({ enabled: false, switchable: true });
    write(OTHERS);
    expect(readLiveText(PROD).enabled).toBe(false);
  });

  it("turning on adds only the entry, with this server's port", () => {
    write(OTHERS);
    expect(setLiveText(true, PROD)).toBe(true);
    expect(read()).toEqual({ ...OTHERS, hooks: { ...OTHERS.hooks, MessageDisplay: [entry(3456)] } });
    expect(readLiveText(PROD).enabled).toBe(true);
  });

  it("turning off puts the file back as it was", () => {
    write(OTHERS);
    setLiveText(true, PROD);
    setLiveText(false, PROD);
    expect(read()).toEqual(OTHERS);
    expect(readLiveText(PROD).enabled).toBe(false);
  });

  it("leaves no hooks key behind in a file that had none", () => {
    write({ model: "opus" });
    setLiveText(true, PROD);
    setLiveText(false, PROD);
    expect(read()).toEqual({ model: "opus" });
  });

  it("creates the file when there is none", () => {
    setLiveText(true, PROD);
    expect(read()).toEqual({ hooks: { MessageDisplay: [entry(3456)] } });
  });

  it("keeps someone else's MessageDisplay hooks, in their own matcher or sharing ours", () => {
    const theirs = { type: "command", command: "tee-it" };
    const theirUrl = { type: "http", url: "http://127.0.0.1:9/elsewhere" };
    write({ hooks: { MessageDisplay: [{ hooks: [theirs] }, { hooks: [theirUrl, entry(3456).hooks[0]] }] } });

    setLiveText(false, PROD);

    expect(read()).toEqual({ hooks: { MessageDisplay: [{ hooks: [theirs] }, { hooks: [theirUrl] }] } });
    expect(readLiveText(PROD).enabled).toBe(false);
  });

  it("turning on twice leaves one entry", () => {
    setLiveText(true, PROD);
    setLiveText(true, PROD);
    expect(read().hooks.MessageDisplay).toEqual([entry(3456)]);
  });

  it("refuses a file it cannot read rather than wiping it", () => {
    writeFileSync(paths.CLAUDE_SETTINGS_PATH, "{ not json");
    expect(() => setLiveText(true, PROD)).toThrow();
    expect(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8")).toBe("{ not json");
    expect(readLiveText(PROD).enabled).toBe(false);
  });
});

describe("a dev server", () => {
  it("does not write, on or off, and says it cannot switch", () => {
    write(OTHERS);
    const before = readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8");
    expect(setLiveText(true, DEV)).toBe(false);
    expect(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8")).toBe(before);
    expect(readLiveText(DEV)).toEqual({ enabled: false, switchable: false });

    setLiveText(true, PROD);
    const on = readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8");
    expect(setLiveText(false, DEV)).toBe(false);
    expect(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8")).toBe(on);
  });

  it("does not move the hook to its own port at startup", async () => {
    setLiveText(true, PROD);
    await followLiveTextPort(DEV, async () => false);
    expect(read().hooks.MessageDisplay).toEqual([entry(3456)]);
  });
});

describe("the port", () => {
  it("follows a server that comes up on another one, and changes nothing else", async () => {
    write(OTHERS);
    setLiveText(true, PROD);
    await followLiveTextPort({ dev: false, port: 4000 }, async () => false);
    expect(read()).toEqual({ ...OTHERS, hooks: { ...OTHERS.hooks, MessageDisplay: [entry(4000)] } });
  });

  it("stays with a server still answering on the old port", async () => {
    setLiveText(true, PROD);
    const asked: number[] = [];
    await followLiveTextPort({ dev: false, port: 4000 }, async (port) => {
      asked.push(port);
      return true;
    });
    expect(asked).toEqual([3456]);
    expect(read().hooks.MessageDisplay).toEqual([entry(3456)]);
  });

  it("recognises its own entry on port 80, which a URL does not spell out", () => {
    setLiveText(true, { dev: false, port: 80 });
    expect(readLiveText(PROD).enabled).toBe(true);
    setLiveText(false, PROD);
    expect(existsSync(paths.CLAUDE_SETTINGS_PATH) && read().hooks).toBeUndefined();
  });

  it("is not installed by startup while the switch is off", async () => {
    write(OTHERS);
    await followLiveTextPort(PROD);
    expect(read()).toEqual(OTHERS);
  });

  it("leaves a file alone when the port is already right", async () => {
    setLiveText(true, PROD);
    writeFileSync(paths.CLAUDE_SETTINGS_PATH, JSON.stringify(read()));
    const before = readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8");
    await followLiveTextPort(PROD);
    expect(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8")).toBe(before);
  });

  it("does not stop a server starting over an unreadable file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(paths.CLAUDE_SETTINGS_PATH, "{ not json");
    await expect(followLiveTextPort(PROD)).resolves.toBeUndefined();
    expect(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8")).toBe("{ not json");
    warn.mockRestore();
  });
});

describe("setup with the hook installed", () => {
  it("does not throw, and leaves the hook and the switch alone", () => {
    write(OTHERS);
    setLiveText(true, PROD);

    expect(() => checkHooksStatus()).not.toThrow();
    const { newSettings } = installHooks();
    saveClaudeSettings(newSettings);

    expect(read().hooks.MessageDisplay).toEqual([entry(3456)]);
    expect(read().hooks.PreToolUse[0]).toEqual(OTHERS.hooks.PreToolUse[0]);
    expect(read().hooks.Stop[0]).toEqual(OTHERS.hooks.Stop[0]);
    expect(readLiveText(PROD).enabled).toBe(true);
    expect(checkHooksStatus()).toBe("current");
  });

  it("does not take the hook for its own when nothing else is installed", () => {
    setLiveText(true, PROD);
    expect(checkHooksStatus()).toBe("install");
  });

  it("uninstalling takes the hook out with the rest, and keeps what is not ours", () => {
    write(OTHERS);
    saveClaudeSettings(installHooks().newSettings);
    setLiveText(true, PROD);

    uninstallHooks();

    expect(read()).toEqual(OTHERS);
  });
});

describe("how the file is written", () => {
  it("writes through a link to nowhere rather than replacing it", () => {
    const real = join(dir, "not-there-yet.json");
    symlinkSync(real, paths.CLAUDE_SETTINGS_PATH);

    setLiveText(true, PROD);

    expect(lstatSync(paths.CLAUDE_SETTINGS_PATH).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8")).hooks.MessageDisplay).toEqual([entry(3456)]);
  });

  it("keeps a symlink a symlink, and the file's mode", () => {
    const real = join(dir, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify(OTHERS), { mode: 0o600 });
    symlinkSync(real, paths.CLAUDE_SETTINGS_PATH);

    setLiveText(true, PROD);

    expect(lstatSync(paths.CLAUDE_SETTINGS_PATH).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8")).hooks.MessageDisplay).toEqual([entry(3456)]);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(existsSync(`${real}.${process.pid}.tmp`)).toBe(false);
  });
});
