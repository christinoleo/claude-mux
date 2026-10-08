import { describe, it, expect } from "vitest";
import { framingVerdict, parseListeners, parseServeStatus } from "../../src/server/web-preview.js";

describe("parseListeners", () => {
  it("reads address, port and process off ss -ltnpH, skipping sockets with no process", () => {
    const out = [
      'LISTEN 0      512                      127.0.0.1:3456  0.0.0.0:* users:(("bun",pid=4084377,fd=9))',
      "LISTEN 0      4096                100.103.110.41:3773  0.0.0.0:*",
      'LISTEN 0      511                          [::1]:5173     [::]:* users:(("node",pid=12,fd=20),("node",pid=12,fd=21))',
      'LISTEN 0      511                              *:3434        *:* users:(("bun",pid=99,fd=3))',
      'LISTEN 0      4096                 127.0.0.53%lo:53    0.0.0.0:* users:(("resolved",pid=7,fd=1))',
      "",
    ].join("\n");
    expect(parseListeners(out)).toEqual([
      { address: "127.0.0.1", port: 3456, pid: 4084377, process: "bun" },
      { address: "::1", port: 5173, pid: 12, process: "node" },
      { address: "*", port: 3434, pid: 99, process: "bun" },
      { address: "127.0.0.53", port: 53, pid: 7, process: "resolved" },
    ]);
  });
});

describe("parseServeStatus", () => {
  it("maps each local port to its HTTPS URL, preferring the mapping that keeps the port", () => {
    const serves = parseServeStatus({
      Web: {
        "box.ts.net:8443": { Handlers: { "/": { Proxy: "http://localhost:3456" } } },
        "box.ts.net:3456": { Handlers: { "/": { Proxy: "http://127.0.0.1:3456" } } },
        "box.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } } },
        "box.ts.net:9000": { Handlers: { "/api": { Proxy: "http://127.0.0.1:9000" } } },
        "box.ts.net:9001": { Handlers: { "/": { Proxy: "http://10.0.0.2:9001" } } },
      },
    });
    expect(serves).toEqual({ 3456: "https://box.ts.net:3456", 18789: "https://box.ts.net" });
  });

  it("reads an empty status as no mappings", () => {
    expect(parseServeStatus({})).toEqual({});
  });
});

describe("framingVerdict", () => {
  const ours = new URL("https://box.ts.net:3456");
  const theirs = new URL("https://example.com/");
  const verdict = (headers: Record<string, string>, from = theirs) => framingVerdict(new Headers(headers), from, ours);

  it("allows a page that says nothing", () => {
    expect(verdict({})).toEqual({ embeddable: true });
  });

  it("refuses X-Frame-Options DENY, and SAMEORIGIN from another origin", () => {
    expect(verdict({ "x-frame-options": "DENY" }).embeddable).toBe(false);
    expect(verdict({ "x-frame-options": "sameorigin" }).embeddable).toBe(false);
    expect(verdict({ "x-frame-options": "SAMEORIGIN" }, new URL("https://box.ts.net:3456/x")).embeddable).toBe(true);
  });

  it("lets frame-ancestors override X-Frame-Options", () => {
    expect(verdict({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors *" })).toEqual({
      embeddable: true,
    });
  });

  it("matches frame-ancestors sources against our origin", () => {
    const csp = (v: string) => verdict({ "content-security-policy": `default-src 'self'; frame-ancestors ${v}` }).embeddable;
    expect(csp("'none'")).toBe(false);
    expect(csp("'self'")).toBe(false);
    expect(csp("https:")).toBe(true);
    expect(csp("*.ts.net:*")).toBe(true);
    expect(csp("https://*.ts.net:3456")).toBe(true);
    expect(csp("https://box.ts.net")).toBe(false);
    expect(csp("https://other.example")).toBe(false);
  });

  it("needs every policy that names frame-ancestors to allow us", () => {
    expect(verdict({ "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" }).embeddable).toBe(false);
  });
});
