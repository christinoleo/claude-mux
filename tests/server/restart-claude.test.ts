import { describe, expect, it } from "vitest";

import { buildRestartCommand, shellQuote, stripResumeFlags } from "../../src/server/restart-claude.js";

describe("stripResumeFlags", () => {
  it("drops every way a launch can name a session", () => {
    expect(stripResumeFlags(["claude", "--resume", "abc", "--model", "opus"])).toEqual(["claude", "--model", "opus"]);
    expect(stripResumeFlags(["claude", "-r", "abc"])).toEqual(["claude"]);
    expect(stripResumeFlags(["claude", "--resume=abc"])).toEqual(["claude"]);
    expect(stripResumeFlags(["claude", "--continue", "-c"])).toEqual(["claude"]);
  });

  it("keeps a flag that follows a bare --resume", () => {
    expect(stripResumeFlags(["claude", "--resume", "--dangerously-skip-permissions"])).toEqual([
      "claude",
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("shellQuote", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(shellQuote("--dangerously-skip-permissions")).toBe("--dangerously-skip-permissions");
    expect(shellQuote("it's a trap")).toBe(`'it'\\''s a trap'`);
  });
});

describe("buildRestartCommand", () => {
  it("replays the running argv with --resume, falling back to a bare claude", () => {
    const own = buildRestartCommand({ id: "sid", pid: process.pid });
    expect(own.endsWith(" --resume sid")).toBe(true);
    expect(buildRestartCommand({ id: "sid", pid: 2 ** 22 - 1 })).toBe("claude --resume sid");
  });
});
