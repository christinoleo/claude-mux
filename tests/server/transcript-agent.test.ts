import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../../src/server/watcher.js", () => ({
  sessionWatcher: { subscribe: () => () => {} },
}));

import { setSessionsDir, upsertSession } from "../../src/db/index.js";
import { TranscriptWsManager, parseWsPath, type WsClient } from "../../src/server/ws-handlers.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const AGENT = "a40433cd6e4f34e5d";

function line(record: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-10-08T00:47:06.000Z", ...record }) + "\n";
}

const PARENT_PROMPT = line({
  type: "user",
  uuid: "p1",
  message: { role: "user", content: "map the queue" },
  origin: { kind: "human" },
  promptSource: "typed",
});
const BRIEF = line({
  type: "user",
  uuid: "b1",
  isSidechain: true,
  message: { role: "user", content: "Find where the queue lives." },
});
const REPLY = line({
  type: "assistant",
  uuid: "r1",
  isSidechain: true,
  message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "It lives in message-queue.ts." }] },
});

interface Msg {
  type: string;
  entries?: { id: string; kind: string }[];
  available?: boolean;
  subagents?: { agentId: string; prompt: string | null }[];
}

let dir: string;
let transcript: string;
let agentFile: string;
let manager: TranscriptWsManager;
const clients: [WsClient, string][] = [];

function client(into: Msg[]): WsClient {
  return { send: (data) => into.push(JSON.parse(data)), isOpen: () => true, close: () => {} };
}

function attach(agentId?: string): Msg[] {
  const received: Msg[] = [];
  const ws = client(received);
  manager.addClient(ws, SESSION, agentId);
  clients.push([ws, SESSION]);
  return received;
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "mux-agent-"));
  setSessionsDir(join(dir, "sessions"));
  const project = join(dir, "projects", "-work");
  transcript = join(project, `${SESSION}.jsonl`);
  mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
  agentFile = join(project, SESSION, "subagents", `agent-${AGENT}.jsonl`);
  writeFileSync(transcript, PARENT_PROMPT);
  upsertSession({ id: SESSION, pid: 1, cwd: "/work", transcript_path: transcript, state: "busy" });
  manager = new TranscriptWsManager();
});

afterEach(() => {
  for (const [ws, id] of clients.splice(0)) manager.removeClient(ws, id);
  vi.clearAllTimers();
  vi.useRealTimers();
  setSessionsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("parseWsPath", () => {
  it("reads an agent's stream off its path", () => {
    expect(parseWsPath(`/api/sessions/${SESSION}/agents/${AGENT}/transcript/stream`)).toEqual({
      type: "transcript",
      target: SESSION,
      agent: AGENT,
    });
    expect(parseWsPath(`/api/sessions/${SESSION}/transcript/stream`)).toEqual({
      type: "transcript",
      target: SESSION,
    });
  });
});

describe("TranscriptWsManager following one subagent", () => {
  it("sends the agent's own entries and brief, and the session's readers none of them", async () => {
    writeFileSync(agentFile, BRIEF);
    const session = attach();
    const agent = attach(AGENT);
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = agent.find((m) => m.type === "snapshot")!;
    expect(snapshot.available).toBe(true);
    expect(snapshot.entries!.map((e) => e.id)).toEqual(["b1"]);
    expect(snapshot.subagents![0].prompt).toBe("Find where the queue lives.");

    appendFileSync(agentFile, REPLY);
    await vi.advanceTimersByTimeAsync(500);

    const delta = agent.filter((m) => m.type === "entries").flatMap((m) => m.entries!);
    expect(delta.map((e) => e.kind)).toContain("text");
    const parentIds = session
      .flatMap((m) => m.entries ?? [])
      .map((e) => e.id);
    expect(parentIds).toEqual(["p1"]);
  });

  it("says an unknown agent is unavailable, then sends it once its file appears", async () => {
    const agent = attach(AGENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(agent[0]).toMatchObject({ type: "snapshot", available: false, entries: [] });

    writeFileSync(agentFile, BRIEF);
    await vi.advanceTimersByTimeAsync(3000);

    const found = agent.filter((m) => m.type === "snapshot").at(-1)!;
    expect(found.available).toBe(true);
    expect(found.entries!.map((e) => e.id)).toEqual(["b1"]);
  });
});
