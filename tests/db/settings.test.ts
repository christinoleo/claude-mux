import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getSettings,
  updateSettings,
  setSettingsPath,
  isClaudeMuxSessionName,
} from "../../src/db/settings-json.js";

const dir = join(tmpdir(), `claude-mux-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const path = join(dir, "settings.json");

describe("settings (JSON file)", () => {
  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    setSettingsPath(path);
  });
  afterEach(() => {
    setSettingsPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to Remote Control off, and remembers a change", () => {
    expect(getSettings()).toEqual({ autoRemoteControl: false });
    expect(updateSettings({ autoRemoteControl: true })).toEqual({ autoRemoteControl: true });
    expect(getSettings().autoRemoteControl).toBe(true);
  });

  it("ignores junk in the file and in a patch", () => {
    writeFileSync(path, JSON.stringify({ autoRemoteControl: "yes", other: 1 }));
    expect(getSettings()).toEqual({ autoRemoteControl: false });
    writeFileSync(path, "{nope");
    expect(getSettings()).toEqual({ autoRemoteControl: false });
    expect(updateSettings({ autoRemoteControl: "true" as unknown as boolean })).toEqual({ autoRemoteControl: false });
  });
});

describe("isClaudeMuxSessionName", () => {
  it("recognises the names claude-mux gives and nothing else", () => {
    expect(isClaudeMuxSessionName("claude-mux-claude-1788298458389")).toBe(true);
    expect(isClaudeMuxSessionName("quita-gemini-1788292133766")).toBe(true);
    expect(isClaudeMuxSessionName("quita-b1")).toBe(false);
    expect(isClaudeMuxSessionName("main")).toBe(false);
    expect(isClaudeMuxSessionName("worker-claude-1")).toBe(false);
  });
});
