import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The real watcher polls ~/.claude-mux; the test drives sessionsChanged itself.
vi.mock("../../src/server/watcher.js", () => ({
  sessionWatcher: { subscribe: () => () => {} },
}));

import { setSessionsDir, upsertSession } from "../../src/db/index.js";
import { TranscriptWsManager, type WsClient } from "../../src/server/ws-handlers.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const PROMPT = JSON.stringify({
  type: "user",
  uuid: "u1",
  timestamp: "2026-10-08T00:47:06.000Z",
  message: { role: "user", content: "hello" },
  origin: { kind: "human" },
  promptSource: "typed",
});

let dir: string;
let transcript: string;
let manager: TranscriptWsManager;
let ws: WsClient;
let received: { type: string; entries?: unknown[] }[];

function client(): WsClient {
  return {
    send: (data) => received.push(JSON.parse(data)),
    isOpen: () => true,
    close: () => {},
  };
}

/** Whether a message carrying the prompt has reached the client. */
function promptArrived(): boolean {
  return received.some((m) => (m.entries?.length ?? 0) > 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "mux-locate-"));
  setSessionsDir(join(dir, "sessions"));
  transcript = join(dir, "projects", "-work", `${SESSION}.jsonl`);
  mkdirSync(join(dir, "projects", "-work"), { recursive: true });
  upsertSession({ id: SESSION, pid: 1, cwd: "/work", transcript_path: transcript, state: "idle" });
  received = [];
  manager = new TranscriptWsManager();
  ws = client();
  manager.addClient(ws, SESSION);
});

afterEach(() => {
  manager.removeClient(ws, SESSION);
  vi.clearAllTimers();
  vi.useRealTimers();
  setSessionsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptWsManager locating a new session's transcript", () => {
  it("looks again on the poll after a hook writes the session JSON", async () => {
    // Idle long enough before the first prompt for the backoff to reach its ceiling.
    await vi.advanceTimersByTimeAsync(60_000);
    writeFileSync(transcript, PROMPT + "\n");

    manager.sessionsChanged([SESSION]);
    await vi.advanceTimersByTimeAsync(500);

    expect(promptArrived()).toBe(true);
  });

  it.each([
    ["with no hook signal", []],
    ["when the change is to a session it is not following", ["someone-else"]],
  ])("still waits out the backoff %s", async (_, changed) => {
    await vi.advanceTimersByTimeAsync(60_000);
    writeFileSync(transcript, PROMPT + "\n");

    manager.sessionsChanged(changed);
    await vi.advanceTimersByTimeAsync(500);

    expect(promptArrived()).toBe(false);
  });
});
