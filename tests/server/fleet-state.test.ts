import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FleetState,
  PERSIST_DELAY_MS,
  PING_MS,
  SILENCE_MS,
  retryDelay,
  type PeerHandlers,
  type PeerLink,
} from "../../src/server/fleet-state.js";

/**
 * The fleet state seam: fake peers whose sockets the test opens, feeds
 * broadcasts into and drops, and what the module merges, retries and keeps on
 * disk.
 */

interface FakeSocket {
  url: string;
  handlers: PeerHandlers;
  sent: string[];
  closed: boolean;
  open(): void;
  broadcast(msg: unknown): void;
  drop(): void;
}

let sockets: FakeSocket[];
let dir: string;

function connect(url: string, handlers: PeerHandlers): PeerLink {
  const socket: FakeSocket = {
    url,
    handlers,
    sent: [],
    closed: false,
    open: () => handlers.open(),
    broadcast: (msg) => handlers.message(JSON.stringify(msg)),
    drop: () => handlers.close(),
  };
  sockets.push(socket);
  return {
    send: (data) => socket.sent.push(data),
    close: () => {
      socket.closed = true;
    },
  };
}

function latest(url: string): FakeSocket {
  const found = sockets.filter((s) => s.url === url);
  return found[found.length - 1];
}

function fleet(path: string | null = join(dir, "fleet.json")) {
  return new FleetState({ selfId: "self", path, connect, version: async () => "1.2.3" });
}

const ENGAGE = { id: "engage-id", hostname: "engage", url: "https://engage:3456" };
const DISTILO = { id: "distilo-id", hostname: "distilo", url: "https://distilo:3456" };

const session = (id: string) => ({ id, state: "idle", tmux_target: `main:${id}` });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  sockets = [];
  dir = mkdtempSync(join(tmpdir(), "fleet-state-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("retryDelay", () => {
  it("waits 5 s, doubles, and stops at a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
});

describe("FleetState", () => {
  it("merges each machine's broadcast into one snapshot, leaving itself out", async () => {
    const state = fleet(null);
    state.update([{ id: "self", hostname: "omarchy", url: "https://omarchy:3456" }, ENGAGE, DISTILO]);
    expect(sockets.map((s) => s.url).sort()).toEqual([DISTILO.url, ENGAGE.url]);

    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "connected", sessions: [session("a")], projects: ["/p/a"], inbox: [] });
    latest(DISTILO.url).open();
    latest(DISTILO.url).broadcast({ type: "sessions", sessions: [session("b"), session("c")], projects: ["/p/b"] });
    await vi.runOnlyPendingTimersAsync();

    const snap = state.snapshot();
    expect(snap.map((m) => m.hostname)).toEqual(["distilo", "engage"]);
    expect(snap[0]).toMatchObject({ online: true, version: "1.2.3", projects: ["/p/b"], retryAt: null });
    expect(snap[0].sessions).toHaveLength(2);
    expect(snap[1]).toMatchObject({ online: true, sessions: [session("a")], projects: ["/p/a"] });
    state.stop();
  });

  it("ignores what is not a sessions broadcast", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [] });
    latest(ENGAGE.url).broadcast({ type: "systemStats", cpu: 1 });
    latest(ENGAGE.url).handlers.message("not json");
    expect(state.snapshot()[0].sessions).toEqual([session("a")]);
    state.stop();
  });

  it("does not pass on a broadcast that repeats the last one, timestamp aside", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    const listener = vi.fn();
    state.subscribe(listener);
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [], timestamp: 1 });
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [], timestamp: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    state.stop();
  });

  it("tells listeners about each change", () => {
    const state = fleet(null);
    const listener = vi.fn();
    state.subscribe(listener);
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], projects: [] });
    expect(listener).toHaveBeenCalled();
    state.stop();
  });

  it("keeps a dropped machine's sessions, marks it offline with when it was last seen, and retries with backoff", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [] });
    const seen = Date.now();

    vi.advanceTimersByTime(3_000);
    latest(ENGAGE.url).drop();
    let m = state.snapshot()[0];
    expect(m).toMatchObject({ online: false, lastSeen: seen, sessions: [session("a")] });
    expect(m.retryAt).toBe(Date.now() + 5_000);

    // Each failed attempt waits twice as long: 5, 10, 20, 40, 60, 60.
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = sockets.length;
      const wait = state.snapshot()[0].retryAt! - Date.now();
      vi.advanceTimersByTime(wait - 1);
      expect(sockets.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(before + 1);
      waits.push(wait);
      latest(ENGAGE.url).drop();
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(state.snapshot()[0].lastSeen).toBe(seen);

    // It answers again: online, and the next drop starts again from 5 s.
    vi.advanceTimersByTime(60_000);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("b")], projects: [] });
    m = state.snapshot()[0];
    expect(m).toMatchObject({ online: true, retryAt: null, sessions: [session("b")], lastSeen: Date.now() });
    latest(ENGAGE.url).drop();
    expect(state.snapshot()[0].retryAt).toBe(Date.now() + 5_000);
    state.stop();
  });

  it("retries at once when asked", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    latest(ENGAGE.url).drop();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(state.snapshot()[0].retryAt! - Date.now());
      latest(ENGAGE.url).drop();
    }
    expect(state.snapshot()[0].retryAt! - Date.now()).toBe(60_000);

    const before = sockets.length;
    expect(state.retryNow(ENGAGE.id)).toBe(true);
    expect(sockets.length).toBe(before + 1);
    expect(state.snapshot()[0].retryAt).toBeNull();
    // The scheduled attempt was cancelled, so nothing else opens when it was due.
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(before + 1);
    // A failure after a manual retry waits from the start again.
    latest(ENGAGE.url).drop();
    expect(state.snapshot()[0].retryAt! - Date.now()).toBe(5_000);

    expect(state.retryNow("nobody")).toBe(false);
    state.stop();
  });

  it("pings an open link and drops one that goes silent", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    const socket = latest(ENGAGE.url);
    socket.open();

    vi.advanceTimersByTime(PING_MS);
    expect(socket.sent).toEqual(["ping"]);
    socket.handlers.message("pong");
    expect(state.snapshot()[0].online).toBe(true);

    vi.advanceTimersByTime(SILENCE_MS + PING_MS);
    expect(socket.closed).toBe(true);
    expect(state.snapshot()[0]).toMatchObject({ online: false });
    state.stop();
  });

  it("reconnects at a machine's new address", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    const moved = { ...ENGAGE, hostname: "engage2", url: "https://engage2:3456" };
    state.update([moved]);
    expect(sockets[0].closed).toBe(true);
    expect(latest(moved.url)).toBeDefined();
    expect(state.snapshot()[0].hostname).toBe("engage2");
    state.stop();
  });

  it("keeps a machine discovery no longer lists", () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    state.update([]);
    expect(state.snapshot().map((m) => m.id)).toEqual([ENGAGE.id]);
    state.stop();
  });

  it("writes its state a little after a change and restores it, offline, after a restart", async () => {
    const path = join(dir, "fleet.json");
    const first = fleet(path);
    first.update([ENGAGE]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: ["/p/a"], inbox: [] });
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
    const seen = first.snapshot()[0].lastSeen;

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.machines[0]).toMatchObject({ id: ENGAGE.id, hostname: "engage", sessions: [session("a")], lastSeen: seen });
    expect(written.machines[0]).not.toHaveProperty("online");
    first.stop();

    // A restart while engage is off: its last word is still there, offline.
    sockets = [];
    const second = fleet(path);
    expect(second.snapshot()[0]).toMatchObject({
      id: ENGAGE.id,
      online: false,
      lastSeen: seen,
      version: "1.2.3",
      sessions: [session("a")],
      projects: ["/p/a"],
    });
    expect(second.addresses()).toEqual([ENGAGE]);

    // Discovery not listing it does not stop it being tried, at its saved address.
    second.update([]);
    expect(latest(ENGAGE.url)).toBeDefined();
    latest(ENGAGE.url).drop();
    expect(second.snapshot()[0].online).toBe(false);
    second.stop();
  });

  it("starts empty from a missing or broken file", () => {
    expect(fleet(join(dir, "missing.json")).snapshot()).toEqual([]);
  });
});

describe("connectPeer", () => {
  it("reads a real peer's sessions socket, unmarked by an Origin, and notices it go", async () => {
    vi.useRealTimers();
    const { WebSocketServer } = await import("ws");
    const { createServer } = await import("node:http");
    const { FORWARDED_HEADER } = await import("../../src/server/fleet-relay.js");
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const seen: { url?: string; origin?: string; forwarded?: string } = {};
    wss.on("connection", (ws, req) => {
      seen.url = req.url;
      seen.origin = req.headers.origin;
      seen.forwarded = req.headers[FORWARDED_HEADER] as string;
      ws.send(JSON.stringify({ type: "connected", sessions: [session("a")], projects: ["/p"], inbox: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const state = new FleetState({ selfId: "self", path: null, version: async () => null });
    state.update([{ id: "peer", hostname: "peer", url }]);
    await vi.waitFor(() => expect(state.snapshot()[0].sessions).toEqual([session("a")]));
    expect(state.snapshot()[0].online).toBe(true);
    expect(seen).toMatchObject({ url: "/api/sessions/stream", origin: undefined, forwarded: "fleet-state" });

    for (const client of wss.clients) client.terminate();
    await vi.waitFor(() => expect(state.snapshot()[0].online).toBe(false));
    expect(state.snapshot()[0].sessions).toEqual([session("a")]);
    state.stop();
    wss.close();
    server.close();
  });
});
