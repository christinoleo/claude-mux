/**
 * The fleet state: what this machine knows about every other machine (ADR
 * 0004).
 *
 * Each machine subscribes to every other machine's sessions broadcast, the
 * same `/api/sessions/stream` a page reads, and keeps per machine its last
 * known sessions, projects (with what matches them across machines), inbox,
 * version and when it was last heard from.
 * The page reads all of it from its origin machine, so a fresh browser on any
 * link sees the whole fleet at once, and a machine that is off keeps what it
 * last said, marked with when that was.
 *
 * A machine that does not answer, or goes quiet, is tried again after 5 s,
 * then twice as long each time up to a minute; `retryNow()` skips the wait.
 * The state is written to disk (a little after each change, so a busy fleet
 * does not write on every broadcast) and read back on start, so the last word
 * of a machine that is off survives a restart of this one.
 *
 * The socket, the clock and the version lookup are injected, so the tests can
 * feed fake broadcasts and disconnects and check what comes out.
 */

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { ProjectReportSchema, type ProjectReport } from "../fleet-projects.js";
import { eachOf } from "../types/ws-messages.js";
import { openForwardedSocket } from "./fleet-relay.js";
import { protocolOf } from "../fleet-protocol.js";

/** A machine discovery found: its stable id, its name, and where its API is. */
export interface PeerAddress {
  id: string;
  hostname: string;
  url: string;
}

/** Everything this machine knows about another one. */
export interface FleetMachineState extends PeerAddress {
  /** Whether its sessions socket is open and answering now. */
  online: boolean;
  /** When it was last heard from (ms), null if never. */
  lastSeen: number | null;
  /** While offline, when the next attempt to reach it is due (ms). */
  retryAt: number | null;
  /** Its claude-mux version, as its health check reports it; null if unknown. */
  version: string | null;
  /** The protocol its health check reports (`src/fleet-protocol.ts`): 0 for one too old to say, null if unknown. */
  protocol: number | null;
  /** Its sessions, projects and inbox as its last broadcast had them, untouched. */
  sessions: unknown[];
  projects: string[];
  /** What it says about each project, to match it across machines (`src/fleet-projects.ts`). */
  projectReports: ProjectReport[];
  inbox: unknown[];
}

/** One open link to a peer's sessions socket. */
export interface PeerLink {
  send(data: string): void;
  close(): void;
}

export interface PeerHandlers {
  open(): void;
  message(data: string): void;
  /** The link closed or failed, whichever way. Called at most once. */
  close(): void;
}

/** Opens a peer's sessions socket at `url` (its base URL). Its handlers are never called before it returns. */
export type PeerConnector = (url: string, handlers: PeerHandlers) => PeerLink;

export interface FleetStateOptions {
  /** This machine's id; discovery lists it too, and it is never followed. */
  selfId: string;
  /** Where the state is kept on disk; null keeps it in memory only. */
  path: string | null;
  connect?: PeerConnector;
  /** A peer's version and protocol, read when its socket opens; null when it does not answer. */
  health?: (url: string) => Promise<PeerHealth | null>;
  /** A peer's fleet preferences, as its socket sent them (`src/server/fleet-prefs.ts`). */
  prefs?: (prefs: unknown) => void;
  now?: () => number;
}

export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
/** How often an open link is pinged, and how long it may stay silent before it counts as gone. */
export const PING_MS = 15_000;
export const SILENCE_MS = 40_000;
/** How long after a change the state is written to disk. */
export const PERSIST_DELAY_MS = 2_000;
/** How often a newer last-seen alone is written. */
export const PERSIST_SEEN_MS = 60_000;

/** The wait before attempt number `failures + 1`: 5 s, doubling, at most a minute. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));
}

interface Peer {
  state: FleetMachineState;
  link: PeerLink | null;
  /** Attempts that failed since it last answered. */
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  /**
   * What the open link last delivered (sessions, projects, reports, inbox; the
   * timestamp left out), so a repeat is not broadcast and written again.
   */
  lastFrame: string | null;
}

type Persisted = { machines: Omit<FleetMachineState, "online" | "retryAt">[] };

export class FleetState {
  private peers = new Map<string, Peer>();
  private listeners = new Set<() => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistedAt = 0;
  private stopped = false;
  private readonly connect: PeerConnector;
  private readonly readHealth: (url: string) => Promise<PeerHealth | null>;
  private readonly now: () => number;
  readonly selfId: string;

  constructor(private readonly options: FleetStateOptions) {
    this.selfId = options.selfId;
    this.connect = options.connect ?? connectPeer;
    this.readHealth = options.health ?? fetchHealth;
    this.now = options.now ?? Date.now;
    for (const saved of this.restore()) {
      this.peers.set(saved.id, this.newPeer({ ...saved, online: false, retryAt: null }));
    }
  }

  /** The machines restored from disk or found since, for the relay to know their addresses. */
  addresses(): PeerAddress[] {
    return [...this.peers.values()].map(({ state }) => ({ id: state.id, hostname: state.hostname, url: state.url }));
  }

  /**
   * Follow the machines discovery found. A new one is connected at once, one
   * whose address changed is reconnected there, and one missing from the list
   * is kept: a machine that is off drops out of discovery, and its last known
   * state is what the page should keep showing. Machines restored from disk
   * and not yet tried are tried now.
   */
  update(found: readonly PeerAddress[]): void {
    if (this.stopped) return;
    let changed = false;
    for (const address of found) {
      if (!address.id || address.id === this.options.selfId) continue;
      const peer = this.peers.get(address.id);
      if (!peer) {
        this.peers.set(address.id, this.newPeer(emptyState(address)));
        changed = true;
        continue;
      }
      if (peer.state.hostname !== address.hostname) {
        peer.state = { ...peer.state, hostname: address.hostname };
        changed = true;
      }
      if (peer.state.url !== address.url) {
        peer.state = { ...peer.state, url: address.url };
        this.drop(peer);
        peer.failures = 0;
        changed = true;
      }
    }
    for (const peer of this.peers.values()) {
      if (!peer.link && !peer.retryTimer) this.open(peer);
    }
    if (changed) this.changed();
  }

  /** Try a machine that is offline now rather than when its wait is up. False for one nobody knows. */
  retryNow(id: string): boolean {
    const peer = this.peers.get(id);
    if (!peer) return false;
    if (peer.state.online || this.stopped) return true;
    this.drop(peer);
    peer.failures = 0;
    this.open(peer);
    return true;
  }

  /** Every other machine, by name. */
  snapshot(): FleetMachineState[] {
    return [...this.peers.values()]
      .map((p) => p.state)
      .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));
  }

  /** Called after every change to the snapshot. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Close every link, cancel every timer and write what is known. */
  stop(): void {
    this.stopped = true;
    for (const peer of this.peers.values()) this.drop(peer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persist();
  }

  private newPeer(state: FleetMachineState): Peer {
    return { state, link: null, failures: 0, retryTimer: null, pingTimer: null, lastFrame: null };
  }

  private open(peer: Peer): void {
    if (this.stopped) return;
    if (peer.state.retryAt !== null) {
      peer.state = { ...peer.state, retryAt: null };
      this.changed();
    }
    const link = this.connect(peer.state.url, {
      open: () => {
        if (peer.link !== link) return;
        peer.failures = 0;
        this.heard(peer);
        peer.pingTimer = setInterval(() => {
          if (this.now() - (peer.state.lastSeen ?? 0) > SILENCE_MS) {
            this.lost(peer, link);
            return;
          }
          link.send("ping");
        }, PING_MS);
        this.setState(peer, { online: true });
        void this.readHealth(peer.state.url).then((health) => {
          if (peer.link !== link || !health) return;
          if (health.version === peer.state.version && health.protocol === peer.state.protocol) return;
          this.setState(peer, health);
        });
      },
      message: (data) => {
        if (peer.link !== link) return;
        this.heard(peer);
        this.receive(peer, data);
      },
      close: () => this.lost(peer, link),
    });
    peer.link = link;
  }

  /**
   * A peer that is quiet but answering pings changes nothing anyone sees, so
   * its newer last-seen is only written to disk, once a minute at most.
   */
  private heard(peer: Peer): void {
    peer.state = { ...peer.state, lastSeen: this.now() };
    if (this.now() - this.persistedAt > PERSIST_SEEN_MS) this.schedulePersist();
  }

  /** A link that closed, failed, or went silent: the machine is offline until the next attempt answers. */
  private lost(peer: Peer, link: PeerLink): void {
    if (peer.link !== link) return;
    this.drop(peer);
    if (this.stopped) return;
    peer.failures++;
    const delay = retryDelay(peer.failures);
    peer.retryTimer = setTimeout(() => {
      peer.retryTimer = null;
      this.open(peer);
    }, delay);
    this.setState(peer, { online: false, retryAt: this.now() + delay });
  }

  /** Let go of a peer's link and timers without touching its state. */
  private drop(peer: Peer): void {
    const link = peer.link;
    peer.link = null;
    peer.lastFrame = null;
    if (peer.pingTimer) clearInterval(peer.pingTimer);
    if (peer.retryTimer) clearTimeout(peer.retryTimer);
    peer.pingTimer = null;
    peer.retryTimer = null;
    if (link) {
      try {
        link.close();
      } catch {
        // Already gone.
      }
    }
  }

  private receive(peer: Peer, data: string): void {
    if (data === "pong") return;
    let msg: {
      type?: unknown;
      sessions?: unknown;
      projects?: unknown;
      projectReports?: unknown;
      inbox?: unknown;
      prefs?: unknown;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.type === "prefs") {
      this.options.prefs?.(msg.prefs);
      return;
    }
    if (msg?.type !== "sessions" && msg?.type !== "connected") return;
    if (!Array.isArray(msg.sessions)) return;
    const frame = JSON.stringify([msg.sessions, msg.projects, msg.projectReports, msg.inbox]);
    if (frame === peer.lastFrame) return;
    peer.lastFrame = frame;
    this.setState(peer, {
      sessions: msg.sessions,
      // An older broadcast may leave these out; what was known stands.
      ...(Array.isArray(msg.projects) ? { projects: msg.projects.filter((p): p is string => typeof p === "string") } : {}),
      ...(Array.isArray(msg.projectReports) ? { projectReports: ReportsSchema.parse(msg.projectReports) } : {}),
      ...(Array.isArray(msg.inbox) ? { inbox: msg.inbox } : {}),
    });
  }

  private setState(peer: Peer, patch: Partial<FleetMachineState>): void {
    peer.state = { ...peer.state, ...patch };
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[fleet] listener failed:", err);
      }
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.options.path && !this.persistTimer && !this.stopped) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persist();
      }, PERSIST_DELAY_MS);
    }
  }

  private persist(): void {
    const path = this.options.path;
    if (!path) return;
    this.persistedAt = this.now();
    const body: Persisted = {
      machines: this.snapshot().map(({ online: _online, retryAt: _retryAt, ...kept }) => kept),
    };
    try {
      writeFileAtomic(path, JSON.stringify(body));
    } catch (err) {
      console.error("[fleet] could not write", path, err);
    }
  }

  private restore(): FleetMachineState[] {
    const path = this.options.path;
    if (!path) return [];
    let saved: Persisted;
    try {
      saved = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(saved?.machines)) return [];
    return saved.machines
      .filter((m) => m && typeof m.id === "string" && typeof m.url === "string" && m.id !== this.options.selfId)
      .map((m) => ({
        ...emptyState({ id: m.id, hostname: String(m.hostname ?? m.id), url: m.url }),
        lastSeen: typeof m.lastSeen === "number" ? m.lastSeen : null,
        version: typeof m.version === "string" ? m.version : null,
        protocol: typeof m.protocol === "number" ? m.protocol : null,
        sessions: Array.isArray(m.sessions) ? m.sessions : [],
        projects: Array.isArray(m.projects) ? m.projects : [],
        projectReports: Array.isArray(m.projectReports) ? ReportsSchema.parse(m.projectReports) : [],
        inbox: Array.isArray(m.inbox) ? m.inbox : [],
      }));
  }
}

function emptyState(address: PeerAddress): FleetMachineState {
  return {
    id: address.id,
    hostname: address.hostname,
    url: address.url,
    online: false,
    lastSeen: null,
    retryAt: null,
    version: null,
    protocol: null,
    sessions: [],
    projects: [],
    projectReports: [],
    inbox: [],
  };
}

/** The reports a peer sent that this version can read; any other is dropped. */
const ReportsSchema = eachOf(ProjectReportSchema);

/** How long a peer has to accept its socket before the attempt counts as failed. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A peer's sessions socket over the runtime's own `WebSocket` (Bun in
 * production, Node under the dev server), sent the way the relay sends: no
 * `Origin`, and marked as forwarded.
 */
export function connectPeer(url: string, handlers: PeerHandlers): PeerLink {
  let socket: WebSocket;
  try {
    socket = openForwardedSocket(url, "/api/sessions/stream", "fleet-state");
  } catch {
    queueMicrotask(handlers.close);
    return { send() {}, close() {} };
  }
  const timer = setTimeout(() => socket.close(), CONNECT_TIMEOUT_MS);
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    handlers.open();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handlers.message(event.data);
  });
  socket.addEventListener("close", () => {
    clearTimeout(timer);
    handlers.close();
  });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    handlers.close();
  });
  return {
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close() {
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    },
  };
}

/** What a peer's health check says about what it runs. */
export interface PeerHealth {
  version: string | null;
  protocol: number;
}

/** A peer's version and protocol from its health check; null when it does not answer. */
export async function fetchHealth(url: string): Promise<PeerHealth | null> {
  try {
    const res = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown; protocol?: unknown };
    return { version: typeof data.version === "string" ? data.version : null, protocol: protocolOf(data) };
  } catch {
    return null;
  }
}
