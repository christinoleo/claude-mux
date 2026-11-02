import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_SETTINGS,
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
    expect(getSettings()).toEqual({ autoRemoteControl: false, autoUpdateClaude: true });
    expect(updateSettings({ autoRemoteControl: true })).toEqual({ autoRemoteControl: true, autoUpdateClaude: true });
    expect(getSettings().autoRemoteControl).toBe(true);
  });

  it("keeps Claude Code up to date unless told not to", () => {
    expect(getSettings().autoUpdateClaude).toBe(true);
    updateSettings({ autoUpdateClaude: false });
    expect(getSettings().autoUpdateClaude).toBe(false);
  });

  it("ignores junk in the file and in a patch", () => {
    writeFileSync(path, JSON.stringify({ autoRemoteControl: "yes", other: 1 }));
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    writeFileSync(path, "{nope");
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(updateSettings({ autoRemoteControl: "true" as unknown as boolean })).toEqual(DEFAULT_SETTINGS);
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
