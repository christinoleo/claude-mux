import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeSocket, WebSocketServer, type WebSocket as PeerSocket } from "ws";
import {
  FORWARDED_HEADER,
  UNREACHABLE_CLOSE,
  openRelayUpstream,
  parseFleetPath,
  relayRequest,
} from "../../src/server/fleet-relay.js";
import { pageOriginAllowed } from "../../src/server/page-origin.js";

/**
 * The relay seam: an origin server running the relay, with a fake peer
 * machine beside it. Requests and sockets go to the origin's
 * `/fleet/<machine>/api/...`, and the test checks what the peer saw and what
 * came back.
 */

const ORIGIN_ID = "origin-machine";

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface SeenSocket {
  url: string;
  headers: IncomingMessage["headers"];
  socket: PeerSocket;
  received: { data: string | Buffer; binary: boolean }[];
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

let peer: Server;
let peerUrl: string;
let origin: Server;
let originUrl: string;
let deadUrl: string;
const seenRequests: SeenRequest[] = [];
const seenSockets: SeenSocket[] = [];

/** The machines the origin knows: the peer, and one that no longer answers. */
async function resolveMachine(id: string): Promise<string | null> {
  if (id === "peer") return peerUrl;
  if (id === "gone") return deadUrl;
  return null;
}

beforeAll(async () => {
  // The fake peer: answers like a claude-mux, and records what reached it.
  peer = createServer(async (req, res) => {
    const body = await readBody(req);
    seenRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    if (req.url === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: [{ id: "s1", machine: "peer" }] }));
    } else if (req.url === "/api/gzipped") {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(gzipSync("squeezed"));
    } else if (req.url?.startsWith("/api/upload")) {
      const parsed = await new Request("http://peer/upload", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body: new Uint8Array(body),
      }).formData();
      const file = parsed.get("file") as File;
      res.writeHead(201, { "content-type": "application/json", "x-peer": "yes" });
      res.end(JSON.stringify({ name: file.name, size: file.size, note: parsed.get("note"), bytes: [...new Uint8Array(await file.arrayBuffer())] }));
    } else if (req.url === "/api/moved") {
      res.writeHead(303, { location: "/api/sessions" });
      res.end();
    } else if (req.url === "/api/missing") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: body.toString() }));
    }
  });
  const peerWss = new WebSocketServer({ server: peer });
  peerWss.on("connection", (socket, req) => {
    const seen: SeenSocket = { url: req.url ?? "", headers: req.headers, socket, received: [] };
    seenSockets.push(seen);
    socket.send(JSON.stringify({ type: "connected", url: req.url }));
    socket.on("message", (data, binary) => {
      seen.received.push({ data: binary ? (data as Buffer) : data.toString(), binary });
      if (!binary && data.toString() === "close-me") socket.close(4001, "peer says bye");
      else socket.send(data, { binary });
    });
  });
  peerUrl = await listen(peer);

  // A port that answers nothing: listened on, then closed.
  const dead = createServer();
  deadUrl = await listen(dead);
  await new Promise((r) => dead.close(r));

  // The origin: the relay's HTTP and socket halves, joined to node's server
  // the way the dev server joins them.
  origin = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", originUrl);
    const target = parseFleetPath(url.pathname);
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const response = await relayRequest(
      new Request(url, { method: req.method, headers, body: body && new Uint8Array(body) }),
      target,
      resolveMachine,
      ORIGIN_ID
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const originWss = new WebSocketServer({ noServer: true });
  origin.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", originUrl);
    const target = parseFleetPath(url.pathname);
    const base = target && pageOriginAllowed(req.headers.origin, req.headers.host) ? await resolveMachine(target.machine) : null;
    if (!target || !base) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    originWss.handleUpgrade(req, socket, head, (ws) => {
      const upstream = openRelayUpstream(
        base,
        `${target.path}${url.search}`,
        { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
        ORIGIN_ID
      );
      ws.on("message", (data, binary) => upstream.send(binary ? (data as Buffer) : data.toString()));
      ws.on("close", () => upstream.close());
    });
  });
  originUrl = await listen(origin);
});

afterAll(async () => {
  await new Promise((r) => origin.close(r));
  await new Promise((r) => peer.close(r));
});

/** A browser-side socket to the origin, with what it has been sent so far. */
function connect(path: string) {
  const ws = new WebSocket(`${originUrl.replace("http", "ws")}${path}`);
  ws.binaryType = "arraybuffer";
  const messages: (string | ArrayBuffer)[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(e.data);
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
  const opened = new Promise<void>((r, j) => {
    ws.addEventListener("open", () => r());
    ws.addEventListener("error", () => j(new Error("socket error")));
  });
  async function next(count: number): Promise<(string | ArrayBuffer)[]> {
    while (messages.length < count) await new Promise<void>((r) => waiters.push(r));
    return messages.slice(0, count);
  }
  return { ws, opened, closed, next };
}

function until(check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (check() ? resolve() : setTimeout(tick, 5));
    tick();
  });
}

describe("parseFleetPath", () => {
  it("splits the machine from the owner's own path", () => {
    expect(parseFleetPath("/fleet/abc-123/api/sessions")).toEqual({ machine: "abc-123", path: "/api/sessions" });
    expect(parseFleetPath("/fleet/abc/api/sessions/main%3A1.0/stream")).toEqual({
      machine: "abc",
      path: "/api/sessions/main%3A1.0/stream",
    });
    expect(parseFleetPath("/fleet/a%20b/api")).toEqual({ machine: "a b", path: "/api" });
  });

  it("is null for anything outside a machine's API", () => {
    expect(parseFleetPath("/api/sessions")).toBeNull();
    expect(parseFleetPath("/fleet/abc")).toBeNull();
    expect(parseFleetPath("/fleet/abc/session/main")).toBeNull();
    expect(parseFleetPath("/fleet/abc/apix")).toBeNull();
    expect(parseFleetPath("/fleet/%E0/api/x")).toBeNull();
  });
});

describe("relay over HTTP", () => {
  it("returns the owning machine's sessions, marked as forwarded and as the owner's own page", async () => {
    const res = await fetch(`${originUrl}/fleet/peer/api/sessions`, {
      headers: { origin: originUrl, "x-custom": "kept" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [{ id: "s1", machine: "peer" }] });

    const seen = seenRequests.at(-1)!;
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/api/sessions");
    expect(seen.headers.origin).toBe(peerUrl);
    expect(seen.headers[FORWARDED_HEADER]).toBe(ORIGIN_ID);
    expect(seen.headers["x-custom"]).toBe("kept");
  });

  it("passes any method with its body and query", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${originUrl}/fleet/peer/api/projects?x=1&y=two`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/home/leo/p" }),
      });
      expect(await res.json()).toEqual({ method, url: "/api/projects?x=1&y=two", body: '{"cwd":"/home/leo/p"}' });
    }
  });

  it("passes a multipart upload byte for byte, and the owner's status and headers back", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 13, 10]);
    const form = new FormData();
    form.append("note", "an attachment");
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "shot.png");
    const res = await fetch(`${originUrl}/fleet/peer/api/upload`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-peer")).toBe("yes");
    expect(await res.json()).toEqual({ name: "shot.png", size: bytes.length, note: "an attachment", bytes: [...bytes] });
  });

  it("hands back a compressed answer decoded, with nothing claiming it is still compressed", async () => {
    const res = await fetch(`${originUrl}/fleet/peer/api/gzipped`);
    expect(await res.text()).toBe("squeezed");
  });

  it("keeps a redirect to the owner's API inside the relay", async () => {
    const res = await fetch(`${originUrl}/fleet/peer/api/moved`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/fleet/peer/api/sessions");
  });

  it("passes the owner's own errors through untouched", async () => {
    const res = await fetch(`${originUrl}/fleet/peer/api/missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("answers 404 with a reason for a machine nobody knows", async () => {
    const res = await fetch(`${originUrl}/fleet/nobody/api/sessions`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown machine", machine: "nobody" });
  });

  it("answers 502 with a reason for a machine that does not answer", async () => {
    const res = await fetch(`${originUrl}/fleet/gone/api/sessions`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "machine unreachable", machine: "gone" });
  });

  it("refuses a page from another origin, before anything reaches the owner", async () => {
    const before = seenRequests.length;
    const res = await fetch(`${originUrl}/fleet/peer/api/sessions/s1/kill`, {
      method: "POST",
      headers: { origin: "https://engage.taimen-pirarucu.ts.net:3456" },
    });
    expect(res.status).toBe(403);
    expect(seenRequests.length).toBe(before);
  });
});

describe("relay over WebSocket", () => {
  it.each([
    ["sessions", "/api/sessions/stream"],
    ["terminal", "/api/sessions/main%3A1.0/stream"],
    ["transcript", "/api/sessions/abc/transcript/stream"],
  ])("carries the %s stream both ways", async (_channel, path) => {
    const client = connect(`/fleet/peer${path}?since=5`);
    await client.opened;
    const [hello] = await client.next(1);
    expect(JSON.parse(hello as string)).toEqual({ type: "connected", url: `${path}?since=5` });

    const seen = seenSockets.at(-1)!;
    expect(seen.headers.origin).toBeUndefined();
    expect(seen.headers[FORWARDED_HEADER]).toBe(ORIGIN_ID);

    client.ws.send("ping");
    client.ws.send(new Uint8Array([9, 8, 7]));
    const [, echoText, echoBinary] = await client.next(3);
    expect(echoText).toBe("ping");
    expect([...new Uint8Array(echoBinary as ArrayBuffer)]).toEqual([9, 8, 7]);
    expect(seen.received.map((m) => m.binary)).toEqual([false, true]);

    client.ws.close();
    await until(() => seen.socket.readyState === seen.socket.CLOSED);
  });

  it("closes the browser's socket with the owner's code when the owner closes", async () => {
    const client = connect("/fleet/peer/api/sessions/stream");
    await client.opened;
    await client.next(1);
    client.ws.send("close-me");
    const event = await client.closed;
    expect(event.code).toBe(4001);
    expect(event.reason).toBe("peer says bye");
  });

  it("refuses a socket from another machine's page, before anything reaches the owner", async () => {
    const before = seenSockets.length;
    const ws = new NodeSocket(`${originUrl.replace("http", "ws")}/fleet/peer/api/sessions/stream`, {
      origin: "https://engage.taimen-pirarucu.ts.net:3456",
    });
    const refused = await new Promise<boolean>((r) => {
      ws.on("open", () => r(false));
      ws.on("error", () => r(true));
    });
    expect(refused).toBe(true);
    expect(seenSockets.length).toBe(before);
  });

  it("closes as unreachable when the owner does not answer", async () => {
    const client = connect("/fleet/gone/api/sessions/stream");
    const event = await client.closed;
    expect(event.code).toBe(UNREACHABLE_CLOSE);
    expect(event.reason).toBe("machine unreachable");
  });
});

