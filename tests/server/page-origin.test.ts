import { describe, expect, it } from "vitest";
import { pageOriginAllowed } from "../../src/server/page-origin.js";

describe("pageOriginAllowed", () => {
  const host = "omarchy.taimen-pirarucu.ts.net:8443";

  it("lets in the page this server served, on any name it answers to", () => {
    expect(pageOriginAllowed("https://omarchy.taimen-pirarucu.ts.net:8443", host)).toBe(true);
    expect(pageOriginAllowed("http://100.68.204.67:3456", "100.68.204.67:3456")).toBe(true);
    expect(pageOriginAllowed("http://localhost:3434", "localhost:3434")).toBe(true);
  });

  it("turns away another machine's page on the tailnet, which goes through its own relay", () => {
    expect(pageOriginAllowed("https://engage.taimen-pirarucu.ts.net:3456", host)).toBe(false);
    expect(pageOriginAllowed("https://omarchy.taimen-pirarucu.ts.net:3456", host)).toBe(false);
    expect(pageOriginAllowed("http://localhost:3434", host)).toBe(false);
    expect(pageOriginAllowed("http://localhost:5173", "localhost:3456")).toBe(false);
  });

  it("turns away a page from anywhere else", () => {
    expect(pageOriginAllowed("https://evil.example", host)).toBe(false);
    expect(pageOriginAllowed("https://omarchy.taimen-pirarucu.ts.net:8443.evil.example", host)).toBe(false);
    expect(pageOriginAllowed("null", host)).toBe(false);
    expect(pageOriginAllowed("https://evil.example", null)).toBe(false);
  });

  it("lets in a client that is not a browser page and sends no Origin", () => {
    expect(pageOriginAllowed(null, host)).toBe(true);
    expect(pageOriginAllowed(undefined, host)).toBe(true);
  });
});
