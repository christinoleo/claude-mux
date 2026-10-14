/**
 * The fleet relay: how a page reaches a machine other than the one that
 * served it (ADR 0004).
 *
 * The origin machine forwards `/fleet/<machine>/api/...` to `/api/...` on the
 * machine with that id — any method, any body, and WebSocket upgrades on every
 * channel — without an allowlist of routes. The tailnet is the only trust
 * between machines: the forwarded request reaches the owner without the
 * browser's `Origin`, so the owner treats it as its own page's, and carries
 * `FORWARDED_HEADER` naming the machine that sent it. An HTTP request carries
 * the owner's own origin in its place, because SvelteKit refuses a form or
 * multipart POST whose `Origin` is not the server's (its CSRF check runs
 * before any hook could wave it through). Every machine runs this
 * same code, so any machine's link is a way in.
 *
 * Nothing here depends on the runtime: requests go out through `fetch` and
 * sockets through the global `WebSocket`, which Bun (production) and Node (the
 * Vite dev server) both provide.
 */

import { pageOriginAllowed } from "./page-origin.js";

export const FORWARDED_HEADER = "x-claude-mux-forwarded";

/**
 * How long a machine has to start answering before it counts as unreachable.
 * Generous, since some routes answer only when their work is done (a voice
 * transcription, a steer that waits for the pane to take it), and a 502 there
 * would have the composer send again what already arrived.
 */
const RESPONSE_TIMEOUT_MS = 120_000;

export interface FleetPath {
  machine: string;
  /** The owner's own path, starting `/api/`. */
  path: string;
}

/** `/fleet/<machine>/api/...` split into the machine and the owner's path, or null. */
export function parseFleetPath(pathname: string): FleetPath | null {
  const match = pathname.match(/^\/fleet\/([^/]+)(\/api(?:\/.*)?)$/);
  if (!match) return null;
  let machine: string;
  try {
    machine = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return { machine, path: match[2] };
}

/** Where a machine's API is reached, by its id; null for a machine nobody knows. */
export type MachineResolver = (machine: string) => Promise<string | null>;

/**
 * Why a page's request may not reach the owner's `path` on `machine` even
 * though the machine is known (one too old for this one, `src/fleet-protocol.ts`),
 * or null to let it through.
 */
export type RelayGate = (machine: string, path: string) => string | null;

function errorResponse(status: number, error: string, machine: string): Response {
  return new Response(JSON.stringify({ error, machine }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Headers that describe one hop, or the browser's page, and must not cross to the owner. */
const REQUEST_HOP_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
  "te",
  "trailer",
  "proxy-connection",
  "proxy-authorization",
]);

/** `fetch` hands back a decoded body, so the owner's encoding and length no longer describe it. */
const RESPONSE_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/**
 * Where a relayed request or socket goes: the base URL of its machine, or the
 * refusal to answer with instead — 403 for another page's origin, 404 for a
 * machine nobody knows, 426 for one the gate turns away, each with a JSON
 * reason.
 */
export async function admitRelay(
  origin: string | null | undefined,
  host: string | null | undefined,
  target: FleetPath,
  resolve: MachineResolver,
  gate?: RelayGate
): Promise<string | Response> {
  const { machine } = target;
  if (!pageOriginAllowed(origin, host)) return errorResponse(403, "cross-origin request refused", machine);
  const base = await resolve(machine);
  if (!base) return errorResponse(404, "unknown machine", machine);
  const refused = gate?.(machine, target.path);
  return refused ? errorResponse(426, refused, machine) : base;
}

/**
 * Forward one HTTP request to the machine `target` names and hand back its
 * answer. Refused as `admitRelay` says, and a machine that does not answer
 * gets 502, with a JSON reason.
 */
export async function relayRequest(
  request: Request,
  target: FleetPath,
  resolve: MachineResolver,
  self: string,
  gate?: RelayGate
): Promise<Response> {
  const base = await admitRelay(request.headers.get("origin"), request.headers.get("host"), target, resolve, gate);
  if (typeof base !== "string") return base;

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!REQUEST_HOP_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set(FORWARDED_HEADER, self);
  headers.set("origin", new URL(base).origin);

  // Buffered rather than streamed: Bun and Node disagree on streaming request
  // bodies, and the largest thing sent this way is an attachment.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${target.path}${new URL(request.url).search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      // A page that goes away mid-request takes the owner's request with it.
      signal: AbortSignal.any([controller.signal, request.signal]),
    });
  } catch {
    return errorResponse(502, "machine unreachable", target.machine);
  } finally {
    clearTimeout(timer);
  }

  const out = new Headers();
  response.headers.forEach((value, name) => {
    if (!RESPONSE_HOP_HEADERS.has(name.toLowerCase())) out.append(name, value);
  });
  // A redirect to the owner's own API is a redirect within the relay.
  const location = out.get("location");
  if (location?.startsWith("/api/")) out.set("location", `/fleet/${encodeURIComponent(target.machine)}${location}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

/** One end of a relayed socket: the browser's, as each server's WebSocket wraps it, or the owner's. */
export interface RelaySocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Close code for an owner that could not be reached. */
export const UNREACHABLE_CLOSE = 1014;

/** A close reason cut to the 123 bytes a close frame holds, on a character boundary. */
function closeReason(reason: string): string {
  const encoder = new TextEncoder();
  let out = reason;
  while (encoder.encode(out).length > 123) out = [...out].slice(0, -1).join("");
  return out;
}

/**
 * A close code one end reported, made fit to send on the other: the codes
 * that only describe what a socket saw (1005 no status, 1006 abnormal, 1015
 * TLS) cannot be sent, and become a plain close.
 */
function sendableCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if ((code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  return 1000;
}

/**
 * A WebSocket to `base` + `path` sent the way the relay sends: no `Origin`,
 * and marked as forwarded by `self`. Throws when the URL cannot be opened.
 */
export function openForwardedSocket(base: string, path: string, self: string): WebSocket {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Bun and Node's WebSocket both take headers in their second argument.
  return new WebSocket(url, { headers: { [FORWARDED_HEADER]: self } } as unknown as string[]);
}

/**
 * Open the owner's end of a relayed socket at `base` + `path` and join it to
 * `client`: whatever either end sends reaches the other unchanged, text as
 * text and binary as binary, and either end closing closes the other. What
 * the browser sends before the owner has answered waits for it.
 */
export function openRelayUpstream(base: string, path: string, client: RelaySocket, self: string): RelaySocket {
  const pending: (string | ArrayBuffer | Uint8Array)[] = [];
  let opened = false;
  let closed = false;
  let socket: WebSocket;

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    try {
      client.close(sendableCode(code), closeReason(reason));
    } catch {
      // Already gone.
    }
  };

  try {
    socket = openForwardedSocket(base, path, self);
  } catch {
    finish(UNREACHABLE_CLOSE, "machine unreachable");
    return { send() {}, close() {} };
  }
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    opened = true;
    for (const data of pending.splice(0)) socket.send(data);
  });
  socket.addEventListener("message", (event) => {
    if (closed) return;
    client.send(event.data as string | ArrayBuffer);
  });
  socket.addEventListener("close", (event) => {
    finish(opened ? event.code : UNREACHABLE_CLOSE, opened ? event.reason : "machine unreachable");
  });
  socket.addEventListener("error", () => {
    if (!opened) finish(UNREACHABLE_CLOSE, "machine unreachable");
  });

  return {
    send(data) {
      if (closed) return;
      if (opened && socket.readyState === WebSocket.OPEN) socket.send(data);
      else pending.push(data);
    },
    close() {
      closed = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    },
  };
}
