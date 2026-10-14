/**
 * The fleet state: what this machine knows about every other machine (ADR
 * 0004).
 *
 * Each machine subscribes to every other machine's sessions broadcast, the
 * same `/api/sessions/stream` a page reads, and keeps per machine its last
 * known sessions, projects (with what matches them across machines), inbox,
 * plugins, version and when it was last heard from.
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
import { FLEET_STATE_SENDER, openForwardedSocket } from "./fleet-relay.js";
import { protocolOf } from "../fleet-protocol.js";
import { PluginsReportSchema, type PluginsReport } from "../fleet-plugins.js";
import { PastSessionSchema, type PastSession } from "../past-session.js";
import { PlainPaneSchema, type PlainPane } from "../fleet-places.js";

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
  /** Its tmux panes that run no Claude session (`src/fleet-places.ts`). */
  panes: PlainPane[];
  inbox: unknown[];
  /** Its Claude Code marketplaces and plugins (`src/fleet-plugins.ts`); null until it reports them. */
  plugins: PluginsReport | null;
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
  /**
   * Its past sessions, as it last listed them. Kept beside the state rather than
   * in it: they change seldom and are many, so they are sent apart from the
   * fleet message that goes out on every broadcast.
   */
  past: PastSession[];
}

type Persisted = { machines: (Omit<FleetMachineState, "online" | "retryAt"> & { past?: unknown })[] };

export class FleetState {
  private peers = new Map<string, Peer>();
  private listeners = new Set<() => void>();
  private pastListeners = new Set<() => void>();
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
    for (const { state, past } of this.restore()) {
      this.peers.set(state.id, { ...this.newPeer({ ...state, online: false, retryAt: null }), past });
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
      // An address belongs to one machine: a record kept for it under another id is that machine's old id.
      for (const other of [...this.peers.values()]) {
        if (other.state.url === address.url && other.state.id !== address.id) {
          this.rekey(other, address.id);
          changed = true;
        }
      }
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

  /** One machine's state by its id, or null for one nobody knows. */
  machine(id: string): FleetMachineState | null {
    return this.peers.get(id)?.state ?? null;
  }

  /** Every other machine, by name. */
  snapshot(): FleetMachineState[] {
    return [...this.peers.values()]
      .map((p) => p.state)
      .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));
  }

  /**
   * Every other machine's past sessions, by machine id: what it listed last,
   * kept while it is off so its conversations stay on the page.
   */
  past(): Record<string, PastSession[]> {
    const out: Record<string, PastSession[]> = {};
    for (const [id, peer] of this.peers) out[id] = peer.past;
    return out;
  }

  /** Called after a machine's past sessions change. Returns the unsubscribe. */
  subscribePast(listener: () => void): () => void {
    this.pastListeners.add(listener);
    return () => this.pastListeners.delete(listener);
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
    return { state, link: null, failures: 0, retryTimer: null, pingTimer: null, lastFrame: null, past: [] };
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
        // Read once per link, and again with each ping until one answers: a
        // protocol left stale would have the relay refuse the machine. The
        // machine counts as online only once the first read is back, so a
        // record whose address now answers with another id is moved to that
        // id before it is ever marked online under the old one.
        let healthKnown = false;
        const readHealth = () =>
          void this.readHealth(peer.state.url)
            .catch(() => null)
            .then((health) => {
              if (peer.link !== link) return;
              const moved = !!health?.instance && health.instance !== peer.state.id;
              if (moved) {
                this.rekey(peer, health.instance!);
                if (peer.link !== link) return this.changed();
              }
              const patch: Partial<FleetMachineState> = peer.state.online ? {} : { online: true };
              if (health) {
                healthKnown = true;
                const version = health.version ?? peer.state.version;
                if (version !== peer.state.version || health.protocol !== peer.state.protocol) {
                  Object.assign(patch, { version, protocol: health.protocol });
                }
              }
              if (moved || Object.keys(patch).length > 0) this.setState(peer, patch);
            });
        peer.pingTimer = setInterval(() => {
          if (this.now() - (peer.state.lastSeen ?? 0) > SILENCE_MS) {
            this.lost(peer, link);
            return;
          }
          link.send("ping");
          if (!healthKnown) readHealth();
        }, PING_MS);
        readHealth();
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

  /**
   * Move a record to the id its address now reports (a machine whose id
   * changed, such as one that began to persist it). When a record is already
   * kept under that id the two become one: the one with a link keeps it (the
   * record under the new id when both or neither have one), the other is let
   * go, and what they knew comes from whichever was heard from last. An
   * address that turns out to be this machine is dropped altogether.
   */
  private rekey(peer: Peer, id: string): void {
    if (this.peers.get(peer.state.id) === peer) this.peers.delete(peer.state.id);
    if (id === this.options.selfId) {
      this.drop(peer);
      this.pastChanged();
      return;
    }
    const existing = this.peers.get(id);
    let kept = peer;
    if (existing && existing !== peer) {
      kept = peer.link && !existing.link ? peer : existing;
      const other = kept === peer ? existing : peer;
      this.drop(other);
      const [fresher, staler] =
        (other.state.lastSeen ?? 0) > (kept.state.lastSeen ?? 0) ? [other, kept] : [kept, other];
      const { url, online, retryAt } = kept.state;
      kept.state = { ...fresher.state, url, online, retryAt };
      kept.past = fresher.past.length > 0 ? fresher.past : staler.past;
      kept.lastFrame = null;
    }
    kept.state = { ...kept.state, id };
    this.peers.set(id, kept);
    this.pastChanged();
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
      panes?: unknown;
      inbox?: unknown;
      plugins?: unknown;
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
    if (msg?.type === "past") {
      const sessions = (msg as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) return;
      const past = PastSchema.parse(sessions);
      if (JSON.stringify(past) === JSON.stringify(peer.past)) return;
      peer.past = past;
      this.pastChanged();
      return;
    }
    if (msg?.type !== "sessions" && msg?.type !== "connected") return;
    if (!Array.isArray(msg.sessions)) return;
    // A plugins report is never changed once read, so its time stands for it.
    const pluginsAt = (msg.plugins as { readAt?: unknown } | null | undefined)?.readAt;
    const frame = JSON.stringify([msg.sessions, msg.panes, msg.projects, msg.projectReports, msg.inbox, pluginsAt]);
    if (frame === peer.lastFrame) return;
    peer.lastFrame = frame;
    this.setState(peer, {
      sessions: msg.sessions,
      // An older broadcast may leave these out; what was known stands.
      ...(Array.isArray(msg.projects) ? { projects: msg.projects.filter((p): p is string => typeof p === "string") } : {}),
      ...(Array.isArray(msg.projectReports) ? { projectReports: ReportsSchema.parse(msg.projectReports) } : {}),
      ...(Array.isArray(msg.panes) ? { panes: PanesSchema.parse(msg.panes) } : {}),
      ...(Array.isArray(msg.inbox) ? { inbox: msg.inbox } : {}),
      ...(msg.plugins && pluginsAt !== peer.state.plugins?.readAt ? { plugins: readPlugins(msg.plugins) ?? peer.state.plugins } : {}),
    });
  }

  private setState(peer: Peer, patch: Partial<FleetMachineState>): void {
    peer.state = { ...peer.state, ...patch };
    this.changed();
  }

  private changed(): void {
    this.notify(this.listeners, "listener");
  }

  private pastChanged(): void {
    this.notify(this.pastListeners, "past listener");
  }

  private notify(listeners: Set<() => void>, what: string): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error(`[fleet] ${what} failed:`, err);
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
      machines: this.snapshot().map(({ online: _online, retryAt: _retryAt, ...kept }) => ({
        ...kept,
        past: this.peers.get(kept.id)?.past ?? [],
      })),
    };
    try {
      writeFileAtomic(path, JSON.stringify(body));
    } catch (err) {
      console.error("[fleet] could not write", path, err);
    }
  }

  private restore(): { state: FleetMachineState; past: PastSession[] }[] {
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
        state: {
          ...emptyState({ id: m.id, hostname: String(m.hostname ?? m.id), url: m.url }),
          lastSeen: typeof m.lastSeen === "number" ? m.lastSeen : null,
          version: typeof m.version === "string" ? m.version : null,
          protocol: typeof m.protocol === "number" ? m.protocol : null,
          sessions: Array.isArray(m.sessions) ? m.sessions : [],
          projects: Array.isArray(m.projects) ? m.projects : [],
          projectReports: Array.isArray(m.projectReports) ? ReportsSchema.parse(m.projectReports) : [],
          panes: Array.isArray(m.panes) ? PanesSchema.parse(m.panes) : [],
          inbox: Array.isArray(m.inbox) ? m.inbox : [],
          plugins: readPlugins(m.plugins),
        },
        past: Array.isArray(m.past) ? PastSchema.parse(m.past) : [],
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
    panes: [],
    inbox: [],
    plugins: null,
  };
}

/** A plugins report a peer sent, or null when this version cannot read it. */
function readPlugins(raw: unknown): PluginsReport | null {
  const parsed = PluginsReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The reports a peer sent that this version can read; any other is dropped. */
const ReportsSchema = eachOf(ProjectReportSchema);
const PastSchema = eachOf(PastSessionSchema);
const PanesSchema = eachOf(PlainPaneSchema);

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
    socket = openForwardedSocket(url, "/api/sessions/stream", FLEET_STATE_SENDER);
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
  /** The machine's stable id (`instance`), when its health check names one. */
  instance?: string | null;
}

/** A peer's version and protocol from its health check; null when it does not answer. */
export async function fetchHealth(url: string): Promise<PeerHealth | null> {
  try {
    const res = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown; protocol?: unknown; instance?: unknown };
    return {
      version: typeof data.version === "string" ? data.version : null,
      protocol: protocolOf(data),
      instance: typeof data.instance === "string" && data.instance ? data.instance : null,
    };
  } catch {
    return null;
  }
}
