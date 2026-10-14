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
  type PeerHealth,
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
  return new FleetState({ selfId: "self", path, connect, health: async () => ({ version: "1.2.3", protocol: 1 }) });
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
    expect(snap[0]).toMatchObject({ online: true, version: "1.2.3", protocol: 1, projects: ["/p/b"], retryAt: null });
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

  it("keeps a dropped machine's sessions, marks it offline with when it was last seen, and retries with backoff", async () => {
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
    await vi.advanceTimersByTimeAsync(0);
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

  it("pings an open link and drops one that goes silent", async () => {
    const state = fleet(null);
    state.update([ENGAGE]);
    const socket = latest(ENGAGE.url);
    socket.open();
    await vi.advanceTimersByTimeAsync(0);

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

  it("moves a machine whose address reports another id to that id, keeping one record", async () => {
    const path = join(dir, "fleet.json");
    const ids = ["engage-old", "engage-new"];
    let reported = ids[0];
    const state = new FleetState({
      selfId: "self",
      path,
      connect,
      health: async () => ({ version: "1.2.3", protocol: 1, instance: reported }),
    });
    state.update([{ ...ENGAGE, id: "engage-old" }]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.snapshot().map((m) => [m.id, m.online])).toEqual([["engage-old", true]]);

    // The machine starts reporting its stable id: the next link's health
    // check moves the record, and the old id is never online again.
    reported = ids[1];
    latest(ENGAGE.url).drop();
    await vi.advanceTimersByTimeAsync(5_000);
    latest(ENGAGE.url).open();
    expect(state.snapshot()[0].online).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.snapshot().map((m) => [m.id, m.online])).toEqual([["engage-new", true]]);
    expect(state.snapshot()[0].sessions).toEqual([session("a")]);
    expect(state.machine("engage-old")).toBeNull();

    // Discovery naming the new id at that address adds no second record.
    state.update([{ ...ENGAGE, id: "engage-new" }]);
    expect(state.snapshot().map((m) => m.id)).toEqual(["engage-new"]);
    state.stop();
    expect(JSON.parse(readFileSync(path, "utf8")).machines.map((m: { id: string }) => m.id)).toEqual(["engage-new"]);
  });

  it("folds two records kept for one address into the id it reports", async () => {
    const state = fleet(null);
    state.update([{ ...ENGAGE, id: "engage-old" }]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [] });
    await vi.advanceTimersByTimeAsync(0);

    state.update([{ ...ENGAGE, id: "engage-new" }]);
    expect(state.snapshot().map((m) => m.id)).toEqual(["engage-new"]);
    expect(state.snapshot()[0].sessions).toEqual([session("a")]);
    state.stop();
  });

  it("keeps the live link and the fresher state when an old record is folded in", async () => {
    const state = new FleetState({
      selfId: "self",
      path: null,
      connect,
      health: async () => ({ version: "1.2.3", protocol: 1, instance: "engage-new" }),
    });
    const moved = { ...ENGAGE, id: "engage-new", url: "https://engage-ts:3456" };
    // An old record, kept for an address that has not answered yet, and the
    // machine under its new id at another address, answering.
    state.update([{ ...ENGAGE, id: "engage-old" }, moved]);
    latest(moved.url).open();
    latest(moved.url).broadcast({ type: "sessions", sessions: [session("fresh")], projects: ["/p/new"] });
    await vi.advanceTimersByTimeAsync(0);
    const live = latest(moved.url);
    expect(state.snapshot().map((m) => [m.id, m.online])).toEqual([
      ["engage-new", true],
      ["engage-old", false],
    ]);

    // The old address answers with the new id: one record stays, on the link
    // that already answered, with what it heard.
    latest(ENGAGE.url).open();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.snapshot().map((m) => [m.id, m.online])).toEqual([["engage-new", true]]);
    expect(live.closed).toBe(false);
    expect(latest(ENGAGE.url).closed).toBe(true);
    expect(state.snapshot()[0]).toMatchObject({ url: moved.url, sessions: [session("fresh")], projects: ["/p/new"] });
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
      protocol: 1,
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

  it("keeps what a machine says about its projects, drops a report it cannot read, and restores them", async () => {
    const path = join(dir, "fleet.json");
    const report = { root: "/home/leo/Projects/claude-mux", remote: "github.com/leo/claude-mux", sub: "", home: "claude-mux", icon: "abc" };
    const first = fleet(path);
    first.update([ENGAGE]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({
      type: "sessions",
      sessions: [],
      projects: [report.root],
      projectReports: [report, { root: 42 }],
    });
    expect(first.snapshot()[0].projectReports).toEqual([report]);

    // A newer report alone is a change worth passing on.
    const listener = vi.fn();
    first.subscribe(listener);
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], projects: [report.root], projectReports: [{ ...report, icon: "def" }] });
    expect(listener).toHaveBeenCalledTimes(1);

    // An older machine sends none: what was known stands.
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [report.root] });
    expect(first.snapshot()[0].projectReports).toEqual([{ ...report, icon: "def" }]);
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
    first.stop();

    sockets = [];
    const second = fleet(path);
    expect(second.snapshot()[0].projectReports).toEqual([{ ...report, icon: "def" }]);
    second.stop();
  });

  it("keeps a machine's plain panes, drops one it cannot read, and restores them", async () => {
    const path = join(dir, "fleet.json");
    const shell = { target: "main:1.0", session: "main", command: "zsh", cwd: "/home/leo", title: "engage" };
    const first = fleet(path);
    first.update([ENGAGE]);
    latest(ENGAGE.url).open();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], projects: [], panes: [shell, { target: 7 }] });
    expect(first.snapshot()[0].panes).toEqual([shell]);

    // A pane that opens is a change worth passing on, though no session moved.
    const listener = vi.fn();
    first.subscribe(listener);
    const server = { ...shell, target: "dev:1.0", session: "dev", command: "node", cwd: "/home/leo/Projects/site" };
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], projects: [], panes: [shell, server] });
    expect(listener).toHaveBeenCalledTimes(1);

    // An older machine sends none: what was known stands.
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], projects: [] });
    expect(first.snapshot()[0].panes).toEqual([shell, server]);
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
    first.stop();

    sockets = [];
    const second = fleet(path);
    expect(second.snapshot()[0].panes).toEqual([shell, server]);
    second.stop();
  });

  it("keeps what a machine says about its plugins, passes on a newer report, and restores it", async () => {
    const path = join(dir, "fleet.json");
    const plugins = {
      marketplaces: [{ name: "ak-plugins", repo: "christinoleo/ak-plugins", commit: "a".repeat(40), latest: "a".repeat(40) }],
      plugins: [{ id: "ak@ak-plugins", version: "1.10.0", enabled: true }],
      readAt: 1,
    };
    const first = fleet(path);
    first.update([ENGAGE]);
    latest(ENGAGE.url).open();
    expect(first.snapshot()[0].plugins).toBeNull();
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], plugins });
    expect(first.snapshot()[0].plugins).toEqual(plugins);

    const listener = vi.fn();
    first.subscribe(listener);
    const newer = { ...plugins, plugins: [], readAt: 2 };
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], plugins: newer });
    expect(listener).toHaveBeenCalledTimes(1);

    // One it cannot read, or none at all (not read yet, an older machine), leaves what was known.
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [], plugins: { marketplaces: "?" } });
    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [session("a")], plugins: null });
    expect(first.snapshot()[0].plugins).toEqual(newer);
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
    first.stop();

    sockets = [];
    const second = fleet(path);
    expect(second.snapshot()[0].plugins).toEqual(newer);
    second.stop();
  });

  it("keeps each machine's past sessions apart from the fleet message, tells their own listeners, and restores them", async () => {
    const state = fleet();
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    const fleetListener = vi.fn();
    const pastListener = vi.fn();
    state.subscribe(fleetListener);
    state.subscribePast(pastListener);
    const past = { id: "p1", cwd: "/p/a", branch: "main", title: null, prompt: "fix it", lastActivity: 1 };
    latest(ENGAGE.url).broadcast({ type: "past", sessions: [past, { id: 3 }], timestamp: 1 });
    latest(ENGAGE.url).broadcast({ type: "past", sessions: [past], timestamp: 2 });
    expect(pastListener).toHaveBeenCalledTimes(1);
    expect(fleetListener).not.toHaveBeenCalled();
    expect(state.past()).toEqual({ [ENGAGE.id]: [past] });
    expect(state.snapshot()[0]).not.toHaveProperty("past");

    // A machine that goes off keeps its list, across a restart too.
    latest(ENGAGE.url).drop();
    expect(state.past()[ENGAGE.id]).toEqual([past]);
    state.stop();
    const again = fleet();
    expect(again.past()).toEqual({ [ENGAGE.id]: [past] });
    again.stop();
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

    const state = new FleetState({ selfId: "self", path: null, health: async () => null });
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

describe("a peer's protocol", () => {
  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("is read again on each ping until its health check answers, keeping the version it knew", async () => {
    const answers: (PeerHealth | null)[] = [null, { version: null, protocol: 0 }];
    const state = new FleetState({ selfId: "self", path: null, connect, health: async () => answers.shift() ?? null });
    state.update([ENGAGE]);
    latest(ENGAGE.url).open();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.snapshot()[0].protocol).toBeNull();

    latest(ENGAGE.url).broadcast({ type: "sessions", sessions: [] });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(state.snapshot()[0]).toMatchObject({ protocol: 0, version: null });
    state.stop();
  });
});
