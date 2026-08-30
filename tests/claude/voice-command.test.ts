import { describe, expect, it } from "vitest";
import { resolveSpokenCommand } from "../../src/claude/voice-command";
import type { DiscoveredCommand } from "../../src/claude/commands";

function cmd(name: string, description = "", insert = name): DiscoveredCommand {
  return { name, insert, kind: "builtin", source: "builtin", description };
}

const COMMANDS: DiscoveredCommand[] = [
  cmd("/model", "Switch model"),
  cmd("/clear", "Clear conversation history"),
  cmd("/code-review", "Review the current diff"),
  cmd("/compact", "Compact conversation"),
  cmd("/ak:linus", "Harsh code review"),
  cmd("/resume", "Resume a previous session"),
];

describe("resolveSpokenCommand", () => {
  it("resolves a spoken 'barra' command", () => {
    const r = resolveSpokenCommand("Barra model.", COMMANDS);
    expect(r.text).toBe("/model");
    expect(r.command?.name).toBe("/model");
  });

  it("resolves a spoken 'slash' command", () => {
    const r = resolveSpokenCommand("Slash clear", COMMANDS);
    expect(r.text).toBe("/clear");
  });

  it("keeps the words after the command as arguments", () => {
    const r = resolveSpokenCommand("barra model opus", COMMANDS);
    expect(r.text).toBe("/model opus");
  });

  it("drops the transcriber's punctuation between command and args", () => {
    const r = resolveSpokenCommand("Barra model, opus.", COMMANDS);
    expect(r.text).toBe("/model opus");
  });

  it("joins multi-word command names across their separator", () => {
    const r = resolveSpokenCommand("barra code review", COMMANDS);
    expect(r.text).toBe("/code-review");
  });

  it("matches namespaced commands spoken as separate words", () => {
    const r = resolveSpokenCommand("barra ak linus", COMMANDS);
    expect(r.text).toBe("/ak:linus");
  });

  it("resolves a literal slash the transcriber wrote itself", () => {
    const r = resolveSpokenCommand("/model opus", COMMANDS);
    expect(r.text).toBe("/model opus");
  });

  it("prefers the shorter match and keeps the rest as args", () => {
    const r = resolveSpokenCommand("barra resume the last session", COMMANDS);
    expect(r.text).toBe("/resume the last session");
  });

  it("recovers the English stem when the transcriber wrote Portuguese", () => {
    expect(resolveSpokenCommand("Barra modelo.", COMMANDS).text).toBe("/model");
    expect(resolveSpokenCommand("barra modelo opus", COMMANDS).text).toBe("/model opus");
  });

  it("leaves text without a leading trigger untouched", () => {
    const text = "please clear the barra thing";
    const r = resolveSpokenCommand(text, COMMANDS);
    expect(r.text).toBe(text);
    expect(r.command).toBeNull();
  });

  it("leaves a bare trigger with no query untouched", () => {
    const r = resolveSpokenCommand("barra", COMMANDS);
    expect(r.text).toBe("barra");
    expect(r.command).toBeNull();
  });

  it("leaves text untouched when nothing matches", () => {
    const r = resolveSpokenCommand("barra xyzzywqx", COMMANDS);
    expect(r.text).toBe("barra xyzzywqx");
    expect(r.command).toBeNull();
  });

  it("leaves text untouched when there are no commands", () => {
    const r = resolveSpokenCommand("barra model", []);
    expect(r.text).toBe("barra model");
    expect(r.command).toBeNull();
  });
});
