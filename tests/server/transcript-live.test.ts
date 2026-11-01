import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../../src/server/watcher.js", () => ({
  sessionWatcher: { subscribe: () => () => {} },
}));

import { setSessionsDir, upsertSession } from "../../src/db/index.js";
import { TranscriptWsManager, type WsClient } from "../../src/server/ws-handlers.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

function assistant(uuid: string, text: string, timestamp: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid,
      timestamp,
      message: { id: `msg-${uuid}`, role: "assistant", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

interface Msg {
  type: string;
  id?: string;
  start?: number;
  text?: string;
  entries?: { id: string; kind: string }[];
  live?: { id: string; text: string }[];
}

let dir: string;
let transcript: string;
let manager: TranscriptWsManager;
const clients: WsClient[] = [];

function attach(): Msg[] {
  const received: Msg[] = [];
  const ws: WsClient = {
    send: (data) => received.push(JSON.parse(data)),
    isOpen: () => true,
    close: () => {},
  };
  manager.addClient(ws, SESSION);
  clients.push(ws);
  return received;
}

const batch = (message_id: string, index: number, delta: string, final = false) => ({
  session_id: SESSION,
  message_id,
  index,
  delta,
  final,
});

const NOW = () => new Date().toISOString();

/** What the hooks do to the session's JSON from Claude Code's process. */
function hookWrites(fields: Record<string, unknown>): void {
  const path = join(dir, "sessions", `${SESSION}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...fields }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
  dir = mkdtempSync(join(tmpdir(), "mux-live-"));
  setSessionsDir(join(dir, "sessions"));
  mkdirSync(join(dir, "project"), { recursive: true });
  transcript = join(dir, "project", `${SESSION}.jsonl`);
  writeFileSync(transcript, assistant("old", "an old reply", "2026-11-01T11:00:00.000Z"));
  upsertSession({ id: SESSION, pid: process.pid, cwd: "/work", transcript_path: transcript, state: "busy" });
  manager = new TranscriptWsManager();
});

afterEach(() => {
  for (const ws of clients.splice(0)) manager.removeClient(ws, SESSION);
  vi.clearAllTimers();
  vi.useRealTimers();
  setSessionsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptWsManager live text", () => {
  it("refuses a session it does not know", () => {
    expect(manager.acceptLiveText({ ...batch("m", 0, "x\n"), session_id: "nobody" })).toBe(false);
  });

  it("forwards batches to a reader, and the entry replaces them in one message", async () => {
    const reader = attach();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.acceptLiveText(batch("m", 0, "one\n"))).toBe(true);
    expect(manager.acceptLiveText(batch("m", 1, "two", true))).toBe(true);
    expect(reader.filter((m) => m.type === "live_batch")).toMatchObject([
      { id: "m", start: 0, text: "one\n" },
      { id: "m", start: 4, text: "two" },
    ]);

    appendFileSync(transcript, assistant("new", "one\ntwo", NOW()));
    await vi.advanceTimersByTimeAsync(500);
    const delta = reader.find((m) => m.type === "entries")!;
    expect(delta.entries!.map((e) => e.kind)).toEqual(["text"]);
    expect(delta.live).toEqual([]);
  });

  it("gives a reader who connects mid-reply the text so far", async () => {
    manager.acceptLiveText(batch("m", 0, "one\n"));
    manager.acceptLiveText(batch("m", 1, "two\n"));
    const late = attach();
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = late.find((m) => m.type === "snapshot")!;
    expect(snapshot.live).toMatchObject([{ id: "m", text: "one\ntwo\n" }]);
    manager.acceptLiveText(batch("m", 2, "three\n"));
    expect(late.at(-1)).toMatchObject({ type: "live_batch", start: 8, text: "three\n" });
  });

  it("drops live text whose entry landed before anyone was reading", async () => {
    manager.acceptLiveText(batch("m", 0, "done", true));
    appendFileSync(transcript, assistant("new", "done", NOW()));
    const late = attach();
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = late.find((m) => m.type === "snapshot")!;
    expect(snapshot.live).toEqual([]);
    expect(snapshot.entries!.map((e) => e.id)).toEqual(["old:0", "new:0"]);
  });

  it("does not match a reply older than the live text on a first read", async () => {
    manager.acceptLiveText(batch("m", 0, "an old reply", true));
    const late = attach();
    await vi.advanceTimersByTimeAsync(0);
    expect(late.find((m) => m.type === "snapshot")!.live).toMatchObject([{ id: "m" }]);
  });

  it("tells readers when a prompt's cut-off text is discarded after 60s", async () => {
    const reader = attach();
    await vi.advanceTimersByTimeAsync(0);
    manager.acceptLiveText(batch("m", 0, "cut off\n"));
    await vi.advanceTimersByTimeAsync(1000);
    hookWrites({ turn_started_at: Date.now() });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reader.some((m) => m.type === "live")).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reader.find((m) => m.type === "live")!.live).toEqual([]);
  });

  it("discards live text when the session dies", async () => {
    const reader = attach();
    await vi.advanceTimersByTimeAsync(0);
    manager.acceptLiveText(batch("m", 0, "orphan\n"));
    hookWrites({ pid: 2 ** 22 + 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reader.find((m) => m.type === "live")!.live).toEqual([]);
  });
});

describe("TranscriptWsManager live text on a cold attach", () => {
  it("sends a reader nothing before its snapshot", async () => {
    const reader = attach();
    manager.acceptLiveText(batch("m", 0, "one\n"));
    expect(reader.some((m) => m.type === "live_batch")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader[0].type).toBe("snapshot");
    expect(reader[0].live).toMatchObject([{ id: "m", text: "one\n" }]);
  });
});
