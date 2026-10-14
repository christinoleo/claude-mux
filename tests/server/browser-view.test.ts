import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BrowserWsManager,
  findBrowserEntry,
  isTabId,
  openableUrl,
  openTab,
  parseTabs,
  tabForUrl,
  toCdpInput,
  type CdpSocket,
} from "../../src/server/browser-view.js";
import type { WsClient } from "../../src/server/ws-handlers.js";

describe("findBrowserEntry", () => {
  it("reads the URL out of an sh -c entry, command substitution and all", () => {
    const config = {
      mcpServers: {
        "chrome-devtools": { command: "bunx", args: ["chrome-devtools-mcp@latest", "--executablePath", "/usr/bin/brave", "--isolated=true"] },
        "brave-windows": {
          command: "sh",
          args: ["-c", "exec bunx chrome-devtools-mcp@latest --browserUrl http://$(tailscale ip -4 asuslaptop):9222"],
        },
      },
    };
    expect(findBrowserEntry(config)).toEqual({
      name: "brave-windows",
      expr: "http://$(tailscale ip -4 asuslaptop):9222",
      shell: true,
    });
  });

  it("stops the shell word at whatever follows it", () => {
    const config = { mcpServers: { b: { command: "/bin/sh", args: ["-c", "mcp --browserUrl=http://10.0.0.2:9222 --verbose; echo done"] } } };
    expect(findBrowserEntry(config)?.expr).toBe("http://10.0.0.2:9222");
  });

  it("reads a plain argument list without a shell", () => {
    expect(findBrowserEntry({ mcpServers: { b: { command: "npx", args: ["mcp", "--browserUrl", "http://10.0.0.2:9222"] } } })).toEqual({
      name: "b",
      expr: "http://10.0.0.2:9222",
      shell: false,
    });
    expect(findBrowserEntry({ mcpServers: { b: { command: "npx", args: ["mcp", "--browserUrl=http://10.0.0.2:9222"] } } })?.expr).toBe(
      "http://10.0.0.2:9222"
    );
  });

  it("finds nothing where no entry names a browser", () => {
    expect(findBrowserEntry({ mcpServers: { a: { command: "npx", args: ["x"] }, b: { type: "http", url: "https://x" } } })).toBeNull();
    expect(findBrowserEntry({})).toBeNull();
    expect(findBrowserEntry(null)).toBeNull();
  });
});

describe("parseTabs", () => {
  it("keeps pages a person could look at, in the browser's order", () => {
    const list = [
      { type: "page", id: "9006C660AAAA", title: "Mail", url: "https://mail.example/" },
      { type: "iframe", id: "9724C85BAAAA", title: "", url: "https://accounts.example/" },
      { type: "service_worker", id: "87127072AAAA", url: "chrome-extension://x/sw.js" },
      { type: "page", id: "D6A3BCEDAAAA", title: "DevTools", url: "devtools://devtools/bundled/x.html" },
      { type: "page", id: "../../json/close", title: "bad", url: "https://x/" },
      { type: "page", id: "A0A0765FAAAA", url: "https://second.example/" },
    ];
    expect(parseTabs(list)).toEqual([
      { id: "9006C660AAAA", title: "Mail", url: "https://mail.example/" },
      { id: "A0A0765FAAAA", title: "", url: "https://second.example/" },
    ]);
    expect(parseTabs({ error: "nope" })).toEqual([]);
  });
});

describe("isTabId", () => {
  it("takes a target id and nothing that could steer a path", () => {
    expect(isTabId("298DE11D21BF8E692247A5279A77EE58")).toBe(true);
    expect(isTabId("a/b")).toBe(false);
    expect(isTabId("..")).toBe(false);
    expect(isTabId("abc?x=1aaaaa")).toBe(false);
  });
});

describe("tabForUrl", () => {
  const tabs = [
    { id: "AAAAAAAA", title: "", url: "https://a.example/x" },
    { id: "BBBBBBBB", title: "", url: "https://b.example/" },
  ];
  it("matches the URL the MCP server reported, a trailing slash or fragment aside", () => {
    expect(tabForUrl(tabs, "https://a.example/x")).toBe("AAAAAAAA");
    expect(tabForUrl(tabs, "https://b.example")).toBe("BBBBBBBB");
    expect(tabForUrl(tabs, "https://a.example/x#top")).toBe("AAAAAAAA");
    expect(tabForUrl(tabs, "https://c.example/")).toBeNull();
    expect(tabForUrl(tabs, null)).toBeNull();
  });
});

describe("toCdpInput", () => {
  it("turns pointer messages into mouse events", () => {
    expect(toCdpInput({ type: "mouse", event: "down", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 8 })).toEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 8 },
    });
    expect(toCdpInput({ type: "mouse", event: "move", x: 1, y: 2 })?.params).toMatchObject({ type: "mouseMoved", button: "none", clickCount: 0 });
    expect(toCdpInput({ type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 120 })?.params).toMatchObject({ type: "mouseWheel", deltaY: 120 });
  });

  it("sends a key that types as keyDown with its text, and any other as rawKeyDown", () => {
    expect(toCdpInput({ type: "key", event: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" })?.params).toMatchObject({
      type: "keyDown",
      text: "a",
      windowsVirtualKeyCode: 65,
    });
    const arrow = toCdpInput({ type: "key", event: "down", key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    expect(arrow?.params).toMatchObject({ type: "rawKeyDown", key: "ArrowDown" });
    expect(arrow?.params).not.toHaveProperty("text");
    expect(toCdpInput({ type: "key", event: "up", key: "a", code: "KeyA", keyCode: 65, text: "a" })?.params).toMatchObject({ type: "keyUp" });
  });

  it("turns text and touches into their calls", () => {
    expect(toCdpInput({ type: "text", text: "hello" })).toEqual({ method: "Input.insertText", params: { text: "hello" } });
    expect(toCdpInput({ type: "touch", event: "start", points: [{ id: 3, x: 5, y: 6 }] })).toEqual({
      method: "Input.dispatchTouchEvent",
      params: { type: "touchStart", touchPoints: [{ x: 5, y: 6, id: 3 }], modifiers: 0 },
    });
    expect(toCdpInput({ type: "touch", event: "end", points: [] })?.params).toMatchObject({ type: "touchEnd", touchPoints: [] });
    expect(toCdpInput({ type: "reload" })).toEqual({ method: "Page.reload", params: {} });
  });

  it("refuses anything that is not one of those", () => {
    expect(toCdpInput({ type: "navigate", url: "https://evil.example/" })).toBeNull();
    expect(toCdpInput({ method: "Page.close" })).toBeNull();
    expect(toCdpInput({ type: "mouse", event: "down", x: "1", y: 2 })).toBeNull();
    expect(toCdpInput({ type: "mouse", event: "explode", x: 1, y: 2 })).toBeNull();
    expect(toCdpInput({ type: "wheel", x: 1, y: 2, deltaX: NaN, deltaY: 1 })).toBeNull();
    expect(toCdpInput({ type: "touch", event: "start", points: [{ x: "a", y: 1 }] })).toBeNull();
    expect(toCdpInput({ type: "text", text: "" })).toBeNull();
    expect(toCdpInput("reload")).toBeNull();
    expect(toCdpInput(null)).toBeNull();
  });
});

/** A stand-in for the browser's end of the DevTools socket. */
class FakeCdp implements CdpSocket {
  sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  methods() {
    return this.sent.map((s) => s.method);
  }
}

function viewer() {
  const got: Record<string, unknown>[] = [];
  let open = true;
  const client: WsClient = {
    send: (data) => void got.push(JSON.parse(data)),
    isOpen: () => open,
    close: () => void (open = false),
  };
  return { client, got, isOpen: () => open };
}

const TAB = "298DE11D21BF8E692247A5279A77EE58";

describe("BrowserWsManager", () => {
  let sockets: FakeCdp[];
  let manager: BrowserWsManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    manager = new BrowserWsManager({
      connect: (url) => {
        const s = new FakeCdp(url);
        sockets.push(s);
        return s;
      },
      endpoint: async () => ({ name: "brave", origin: "http://100.1.2.3:9222" }),
    });
  });
  afterEach(() => vi.useRealTimers());

  /** Add a viewer and bring the tab's socket up. */
  async function watch() {
    const v = viewer();
    expect(manager.addClient(v.client, TAB)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets.at(-1)!;
    if (socket.sent.length === 0) socket.onopen?.({});
    return { ...v, socket };
  }

  const frame = (data: string, sessionId = 1) => ({
    method: "Page.screencastFrame",
    params: { data, sessionId, metadata: { deviceWidth: 1200, deviceHeight: 800 } },
  });

  it("attaches to the tab by id and starts a screencast", async () => {
    const { socket } = await watch();
    expect(socket.url).toBe(`ws://100.1.2.3:9222/devtools/page/${TAB}`);
    expect(socket.methods()).toEqual(["Page.enable", "Page.startScreencast"]);
    expect(socket.methods()).not.toContain("Page.bringToFront");
  });

  it("relays frames with the viewport they show, and acks each", async () => {
    const { socket, got } = await watch();
    socket.emit(frame("AAAA", 7));
    expect(got).toEqual([{ type: "frame", data: "AAAA", width: 1200, height: 800 }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.at(-1)).toMatchObject({ method: "Page.screencastFrameAck", params: { sessionId: 7 } });
  });

  it("shares one connection between viewers and hands a latecomer the last frame", async () => {
    const first = await watch();
    first.socket.emit(frame("AAAA"));
    const second = viewer();
    manager.addClient(second.client, TAB);
    expect(sockets).toHaveLength(1);
    expect(second.got).toEqual([{ type: "frame", data: "AAAA", width: 1200, height: 800 }]);
    expect(manager.getStats()).toEqual({ tabs: 1, viewers: 2 });
  });

  it("forwards a viewer's input and nothing else", async () => {
    const { socket, client } = await watch();
    manager.handleMessage(client, TAB, JSON.stringify({ type: "text", text: "hi" }));
    manager.handleMessage(client, TAB, JSON.stringify({ type: "navigate", url: "https://evil.example" }));
    manager.handleMessage(client, TAB, "not json");
    manager.handleMessage(viewer().client, TAB, JSON.stringify({ type: "reload" }));
    expect(socket.methods().slice(2)).toEqual(["Input.insertText"]);
  });

  it("stops the screencast and drops the socket when the last viewer leaves", async () => {
    const first = await watch();
    const second = viewer();
    manager.addClient(second.client, TAB);
    manager.removeClient(first.client, TAB);
    expect(first.socket.closed).toBe(false);
    manager.removeClient(second.client, TAB);
    expect(first.socket.methods().at(-1)).toBe("Page.stopScreencast");
    expect(first.socket.closed).toBe(true);
    expect(manager.getStats()).toEqual({ tabs: 0, viewers: 0 });
  });

  it("never connects for a viewer who left before the address resolved", async () => {
    const v = viewer();
    manager.addClient(v.client, TAB);
    manager.removeClient(v.client, TAB);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
  });

  it("falls back to screenshots while the screencast stays silent", async () => {
    const { socket, got } = await watch();
    await vi.advanceTimersByTimeAsync(2100);
    const shot = socket.sent.find((s) => s.method === "Page.captureScreenshot")!;
    const metrics = socket.sent.find((s) => s.method === "Page.getLayoutMetrics")!;
    expect(shot).toBeDefined();
    socket.emit({ id: shot.id, result: { data: "SHOT" } });
    socket.emit({ id: metrics.id, result: { cssVisualViewport: { clientWidth: 1000, clientHeight: 700 } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([{ type: "frame", data: "SHOT", width: 1000, height: 700 }]);

    // Once frames flow, the screenshots stop.
    socket.emit(frame("AAAA"));
    const before = socket.sent.filter((s) => s.method === "Page.captureScreenshot").length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.sent.filter((s) => s.method === "Page.captureScreenshot")).toHaveLength(before);
  });

  it("takes screenshots again when the tab says it is no longer visible", async () => {
    const { socket } = await watch();
    socket.emit(frame("AAAA"));
    socket.emit({ method: "Page.screencastVisibilityChanged", params: { visible: false } });
    await vi.advanceTimersByTimeAsync(1100);
    expect(socket.methods()).toContain("Page.captureScreenshot");
  });

  it("reports the main frame's navigations and ignores a subframe's", async () => {
    const { socket, got } = await watch();
    socket.emit({ method: "Page.frameNavigated", params: { frame: { id: TAB, url: "https://a.example/" } } });
    socket.emit({ method: "Page.frameNavigated", params: { frame: { id: "sub", parentId: TAB, url: "https://ad.example/" } } });
    socket.emit({ method: "Page.navigatedWithinDocument", params: { frameId: TAB, url: "https://a.example/#x" } });
    expect(got).toEqual([
      { type: "nav", url: "https://a.example/" },
      { type: "nav", url: "https://a.example/#x" },
    ]);
  });

  it("tells viewers and closes them when the tab goes away", async () => {
    const v = await watch();
    v.socket.onclose?.({});
    expect(v.got).toEqual([{ type: "closed", reason: "The tab was closed." }]);
    expect(v.isOpen()).toBe(false);
    expect(manager.getStats().tabs).toBe(0);
  });

  it("says so when the browser cannot be reached", async () => {
    const v = viewer();
    manager.addClient(v.client, TAB);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].onerror?.({});
    expect(v.got).toEqual([{ type: "closed", reason: "Could not reach the browser." }]);
    expect(v.isOpen()).toBe(false);
  });

  it("refuses an id that is not a tab's, and says so", () => {
    const v = viewer();
    expect(manager.addClient(v.client, "../json/close/x")).toBe(false);
    expect(v.got).toEqual([{ type: "closed", reason: "That is not a tab." }]);
  });

  it("turns a viewer away with a reason once too many tabs are streaming", () => {
    for (let i = 0; i < 8; i++) expect(manager.addClient(viewer().client, `TAB0000${i}`)).toBe(true);
    const v = viewer();
    expect(manager.addClient(v.client, "TAB00009")).toBe(false);
    expect(v.got[0]).toMatchObject({ type: "closed" });
  });

  it("sends frames past the socket's compression where the socket allows", async () => {
    const { socket, client } = await watch();
    const raw: string[] = [];
    client.sendUncompressed = (data) => void raw.push(data);
    socket.emit(frame("AAAA"));
    socket.emit({ method: "Page.frameNavigated", params: { frame: { id: TAB, url: "https://a.example/" } } });
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0])).toMatchObject({ type: "frame", data: "AAAA" });
  });
});

describe("openableUrl", () => {
  it("takes a github.com pull request or issue page", () => {
    expect(openableUrl("https://github.com/christinoleo/claude-mux/pull/124")).toBe(
      "https://github.com/christinoleo/claude-mux/pull/124",
    );
    expect(openableUrl("https://github.com/christinoleo/claude-mux/issues/7")).toBe(
      "https://github.com/christinoleo/claude-mux/issues/7",
    );
  });

  it("refuses anything else", () => {
    for (const url of [
      "http://github.com/a/b/pull/1",
      "https://github.com.evil.example/a/b/pull/1",
      "https://evil.example/https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1/files",
      "https://github.com/a/b/pull/1?x=1",
      "https://github.com/a/b/pull/1#c",
      "https://github.com/a/b",
      "https://user@github.com/a/b/pull/1",
      "javascript:alert(1)",
      "",
      42,
      null,
    ]) {
      expect(openableUrl(url), String(url)).toBeNull();
    }
  });
});

describe("openTab", () => {
  const endpoint = async () => ({ name: "brave-windows", origin: "http://100.1.2.3:9222" });
  const page = (id: string, url: string) => ({ type: "page", id, url, title: "" });

  function browser(list: unknown[]) {
    const sent: { url: string; msg: Record<string, unknown> }[] = [];
    let next = 0;
    const fetchFake = (async (url: string) => {
      const body = url.endsWith("/json/list")
        ? list
        : { webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/b-1234567890" };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const connect = (url: string): CdpSocket => {
      const socket: CdpSocket = {
        send(data) {
          const msg = JSON.parse(data);
          sent.push({ url, msg });
          const targetId = `NEWTAB-${String(++next).padStart(4, "0")}`;
          list.push(page(targetId, String(msg.params.url)));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { targetId } }) }));
        },
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    };
    return { sent, deps: { endpoint, fetch: fetchFake, connect } };
  }

  it("opens a background tab through the browser's own socket, reached at the configured address", async () => {
    const b = browser([page("MINE-00001", "https://example.com/")]);
    const url = "https://github.com/o/r/pull/1";
    expect(await openTab(url, b.deps)).toEqual({ tab: "NEWTAB-0001" });
    expect(b.sent).toEqual([
      {
        url: "ws://100.1.2.3:9222/devtools/browser/b-1234567890",
        msg: { id: 1, method: "Target.createTarget", params: { url, background: true } },
      },
    ]);
  });

  it("reuses the tab it opened while that tab is open, and opens another once it is gone", async () => {
    const list: Record<string, unknown>[] = [];
    const b = browser(list);
    const url = "https://github.com/o/r/issues/2";
    const first = await openTab(url, b.deps);
    expect(await openTab(url, b.deps)).toEqual(first);
    expect(b.sent).toHaveLength(1);
    list.splice(0);
    expect(await openTab(url, b.deps)).not.toEqual(first);
    expect(b.sent).toHaveLength(2);
  });

  it("never hands over a tab someone else opened on the same page", async () => {
    const url = "https://github.com/o/r/pull/3";
    const b = browser([page("THEIRS-0001", url)]);
    expect(await openTab(url, b.deps)).toEqual({ tab: "NEWTAB-0001" });
  });

  it("says why when the browser is not there", async () => {
    const off = await openTab("https://github.com/o/r/pull/4", {
      endpoint,
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(off).toEqual({ error: expect.stringContaining("brave-windows") });
    expect(await openTab("https://github.com/o/r/pull/4", { endpoint: async () => null })).toEqual({
      error: "No browser is configured.",
    });
  });
});
