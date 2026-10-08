import { describe, it, expect } from "vitest";
import { choiceUrl, normalizeTyped, resolveEmbed, type EmbedContext } from "../../web/src/lib/side-panel/web.js";

const server = (port: number, loopbackOnly = false) => ({
  port,
  url: `http://localhost:${port}/`,
  pid: 1,
  process: "node",
  loopbackOnly,
});

describe("choiceUrl", () => {
  const info = { urls: { prod: "https://example.com" }, detected: [server(5173), server(3434)] };

  it("reads prod and dev off the config, dev falling back to the first server found", () => {
    expect(choiceUrl("prod", info)).toBe("https://example.com");
    expect(choiceUrl("dev", info)).toBe("http://localhost:5173/");
    expect(choiceUrl("dev", { ...info, urls: { dev: "http://localhost:8080" } })).toBe("http://localhost:8080");
    expect(choiceUrl("dev", { urls: {}, detected: [] })).toBeNull();
    expect(choiceUrl("https://x.dev/a", info)).toBe("https://x.dev/a");
  });
});

describe("normalizeTyped", () => {
  it("adds a scheme, http for this machine and https elsewhere", () => {
    expect(normalizeTyped("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeTyped("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeTyped(" http://a.b ")).toBe("http://a.b/");
    expect(normalizeTyped("ftp://a.b")).toBeNull();
    expect(normalizeTyped("")).toBeNull();
  });
});

describe("resolveEmbed", () => {
  const ctx = (page: string, over: Partial<EmbedContext> = {}): EmbedContext => {
    const u = new URL(page);
    return {
      page: { protocol: u.protocol, hostname: u.hostname },
      serves: {},
      detected: [],
      ...over,
    };
  };

  it("frames a remote HTTPS page as it is", () => {
    expect(resolveEmbed("https://example.com/x", ctx("https://box.ts.net:3456"))).toEqual({
      kind: "frame",
      src: "https://example.com/x",
    });
  });

  it("refuses plain HTTP inside an HTTPS page", () => {
    const e = resolveEmbed("http://example.com/", ctx("https://box.ts.net:3456"));
    expect(e).toMatchObject({ kind: "card", open: "http://example.com/" });
  });

  it("frames a local server through its tailscale serve mapping, keeping the path", () => {
    const e = resolveEmbed(
      "http://localhost:5173/app?q=1",
      ctx("https://box.ts.net:3456", { serves: { 5173: "https://box.ts.net:5173" } })
    );
    expect(e).toEqual({ kind: "frame", src: "https://box.ts.net:5173/app?q=1" });
  });

  it("frames localhost as it is when the page is open on this machine", () => {
    expect(resolveEmbed("http://0.0.0.0:5173/", ctx("http://localhost:3434"))).toEqual({
      kind: "frame",
      src: "http://localhost:5173/",
    });
  });

  it("offers an unmapped local server in a new tab with the command, from another device", () => {
    const e = resolveEmbed("http://localhost:5173/", ctx("https://box.ts.net:3456"));
    expect(e).toMatchObject({
      kind: "card",
      open: "http://box.ts.net:5173/",
      command: "tailscale serve --bg --https=5173 http://localhost:5173",
    });
  });

  it("says a loopback-only server is out of reach from another device, even over plain HTTP", () => {
    const e = resolveEmbed("http://localhost:5173/", ctx("http://box.ts.net:3434", { detected: [server(5173, true)] }));
    expect(e).toMatchObject({ kind: "card", command: "tailscale serve --bg --https=5173 http://localhost:5173" });
    expect(e.kind === "card" && e.reason).toMatch(/127\.0\.0\.1 only/);
  });

  it("rewrites localhost to the name the device reached claude-mux by", () => {
    expect(resolveEmbed("http://localhost:5173/a", ctx("http://192.168.1.10:3434"))).toEqual({
      kind: "frame",
      src: "http://192.168.1.10:5173/a",
    });
  });

  it("frames a rewritten local server from a plain-HTTP page on another device", () => {
    expect(resolveEmbed("http://localhost:5173/", ctx("http://box.ts.net:3434"))).toEqual({
      kind: "frame",
      src: "http://box.ts.net:5173/",
    });
  });
});
