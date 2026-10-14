import { describe, expect, it } from "vitest";
import { socketOriginAllowed } from "../../src/server/ws-handlers.js";

describe("socketOriginAllowed", () => {
  const host = "omarchy.taimen-pirarucu.ts.net:8443";

  it("lets in the page this server served, on any name it answers to", () => {
    expect(socketOriginAllowed("https://omarchy.taimen-pirarucu.ts.net:8443", host)).toBe(true);
    expect(socketOriginAllowed("http://100.68.204.67:3456", "100.68.204.67:3456")).toBe(true);
    expect(socketOriginAllowed("http://omarchy:3456", "omarchy:3456")).toBe(true);
  });

  it("lets in another machine's page on the tailnet, and a loopback dev server", () => {
    expect(socketOriginAllowed("https://engage.taimen-pirarucu.ts.net:3456", host)).toBe(true);
    expect(socketOriginAllowed("http://localhost:3434", host)).toBe(true);
    expect(socketOriginAllowed("http://127.0.0.1:5173", host)).toBe(true);
  });

  it("turns away a page from anywhere else", () => {
    expect(socketOriginAllowed("https://evil.example", host)).toBe(false);
    expect(socketOriginAllowed("https://ts.net.evil.example", host)).toBe(false);
    expect(socketOriginAllowed("https://omarchy.taimen-pirarucu.ts.net.evil.example", host)).toBe(false);
    expect(socketOriginAllowed("null", host)).toBe(false);
    expect(socketOriginAllowed("https://evil.example", null)).toBe(false);
  });

  it("lets in a client that is not a browser page and sends no Origin", () => {
    expect(socketOriginAllowed(null, host)).toBe(true);
    expect(socketOriginAllowed(undefined, host)).toBe(true);
  });
});
