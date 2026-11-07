import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const paths = vi.hoisted(() => ({ CLAUDE_DIR: "", CLAUDE_SETTINGS_PATH: "", CLAUDE_MUX_DIR: "" }));
vi.mock("../../src/utils/paths.js", () => paths);

const { machineOn, readMachineSwitch, setMachineSwitch, followMachineSwitch, settleMachineSwitch, MACHINE_OFF } = await import(
  "../../src/server/machine-switch.js"
);
const { setLiveText, readLiveText } = await import("../../src/server/live-text-switch.js");
const { setDialogAnswers, readDialogAnswers } = await import("../../src/server/dialog-switch.js");
const { setEventMapPath, updateProjectEvents } = await import("../../src/db/event-map-json.js");

const PROD = { dev: false, port: 3456 };
const DEV = { dev: true, port: 3434 };
const OTHERS = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } };

let dir: string;
const settings = () => JSON.parse(readFileSync(paths.CLAUDE_SETTINGS_PATH, "utf-8"));
const switchFile = () => join(paths.CLAUDE_MUX_DIR, "machine-switch.json");
const hooks = () => ({ liveText: readLiveText(PROD).enabled, dialog: readDialogAnswers(PROD).enabled });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-mux-machine-switch-"));
  paths.CLAUDE_DIR = join(dir, ".claude");
  paths.CLAUDE_SETTINGS_PATH = join(paths.CLAUDE_DIR, "settings.json");
  paths.CLAUDE_MUX_DIR = join(dir, ".claude-mux");
  mkdirSync(paths.CLAUDE_DIR);
  mkdirSync(paths.CLAUDE_MUX_DIR);
  writeFileSync(paths.CLAUDE_SETTINGS_PATH, JSON.stringify(OTHERS));
  delete process.env.CLAUDE_MUX_EVENTS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_MUX_EVENTS;
});

describe("the machine's switch", () => {
  it("is off where nothing was ever switched on, and says so in one reason", () => {
    expect(machineOn()).toBe(false);
    expect(readMachineSwitch(PROD)).toEqual({ on: false, switchable: true });
    expect(MACHINE_OFF).toBe("Off on this machine");
  });

  it("on adds both hooks with this server's port; off removes both and puts the settings back", () => {
    expect(setMachineSwitch(true, PROD)).toBe(true);
    expect(machineOn()).toBe(true);
    expect(hooks()).toEqual({ liveText: true, dialog: true });
    expect(JSON.stringify(settings())).toContain("127.0.0.1:3456/api/hooks/message-display");

    expect(setMachineSwitch(false, PROD)).toBe(true);
    expect(machineOn()).toBe(false);
    expect(hooks()).toEqual({ liveText: false, dialog: false });
    expect(settings()).toEqual(OTHERS);
  });

  it("a dev server reads it but does not turn it, unless it polls GitHub under a HOME of its own, and never writes hooks", () => {
    expect(readMachineSwitch(DEV).switchable).toBe(false);
    expect(setMachineSwitch(true, DEV)).toBe(false);
    expect(machineOn()).toBe(false);

    process.env.CLAUDE_MUX_EVENTS = "1";
    expect(readMachineSwitch(DEV).switchable).toBe(true);
    expect(setMachineSwitch(true, DEV)).toBe(true);
    expect(machineOn()).toBe(true);
    expect(hooks()).toEqual({ liveText: false, dialog: false });
  });
});

describe("moving over from the old switches", () => {
  it("starts on where live text was on, and keeps it", () => {
    setLiveText(true, PROD);
    expect(machineOn()).toBe(true);
    settleMachineSwitch(PROD);
    expect(JSON.parse(readFileSync(switchFile(), "utf-8"))).toEqual({ on: true });
    expect(hooks().liveText).toBe(true);
  });

  it("starts on where dashboard approvals were on", () => {
    setDialogAnswers(true, PROD);
    expect(machineOn()).toBe(true);
  });

  it("starts on where the worker queue's own switch was on", () => {
    writeFileSync(join(paths.CLAUDE_MUX_DIR, "worker-queue.json"), JSON.stringify({ settings: { enabled: true, limit: 4 } }));
    expect(machineOn()).toBe(true);
  });

  it("starts on where a clock Trigger ran, since Triggers had no switch, but not for paused ones", () => {
    const triggers = (paused: boolean) =>
      writeFileSync(join(paths.CLAUDE_MUX_DIR, "triggers.json"), JSON.stringify({ triggers: [{ id: "t1", paused }], runs: [] }));
    triggers(true);
    expect(machineOn()).toBe(false);
    triggers(false);
    expect(machineOn()).toBe(true);
  });

  it("starts on where claude-mux's pushes went to the release rule", () => {
    setEventMapPath(join(dir, "event-map.json"));
    try {
      updateProjectEvents("christinoleo/claude-mux", { enabled: true, root: "/p/cm", events: { push: "ignore" } });
      expect(machineOn()).toBe(false);
      updateProjectEvents("christinoleo/claude-mux", { events: { push: "rule" } });
      expect(machineOn()).toBe(true);
    } finally {
      setEventMapPath(null);
    }
  });

  it("is written down only by a server that may, and then once", () => {
    setLiveText(true, PROD);
    settleMachineSwitch(DEV);
    expect(existsSync(switchFile())).toBe(false);
    setLiveText(false, PROD);
    expect(machineOn()).toBe(false);
  });

  it("starts off where every old switch was off, and decides once", () => {
    writeFileSync(join(paths.CLAUDE_MUX_DIR, "worker-queue.json"), JSON.stringify({ settings: { enabled: false } }));
    expect(machineOn()).toBe(false);
    settleMachineSwitch(PROD);
    // Written down: a hook added by hand later does not turn the machine on.
    setLiveText(true, PROD);
    expect(machineOn()).toBe(false);
  });
});

describe("at startup", () => {
  it("adds the hooks a switched-on machine is missing, and moves them to a new port", async () => {
    writeFileSync(switchFile(), JSON.stringify({ on: true }));
    await followMachineSwitch(PROD, async () => false);
    expect(hooks()).toEqual({ liveText: true, dialog: true });

    await followMachineSwitch({ dev: false, port: 4000 }, async () => false);
    expect(JSON.stringify(settings())).toContain("127.0.0.1:4000/api/hooks/message-display");
    expect(JSON.stringify(settings())).not.toContain(":3456/");
  });

  it("removes hooks left on a switched-off machine", async () => {
    setLiveText(true, PROD);
    setDialogAnswers(true, PROD);
    writeFileSync(switchFile(), JSON.stringify({ on: false }));
    await followMachineSwitch(PROD, async () => false);
    expect(settings()).toEqual(OTHERS);
  });

  it("changes nothing on a dev server", async () => {
    writeFileSync(switchFile(), JSON.stringify({ on: true }));
    await followMachineSwitch(DEV, async () => false);
    expect(hooks()).toEqual({ liveText: false, dialog: false });
    expect(existsSync(switchFile())).toBe(true);
  });
});
