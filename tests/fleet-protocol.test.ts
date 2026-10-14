import { describe, expect, it } from "vitest";
import {
  MIN_PROTOCOL,
  PROTOCOL,
  belowMinimum,
  protocolOf,
  protocolRefusal,
  relayRefusal,
} from "../src/fleet-protocol.js";

describe("protocolOf", () => {
  it("reads a health check's protocol, and 0 for one too old to report it", () => {
    expect(protocolOf({ protocol: 3 })).toBe(3);
    expect(protocolOf({})).toBe(0);
    expect(protocolOf({ protocol: "1" })).toBe(0);
  });
});

describe("the minimum protocol", () => {
  it("is met by this build", () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(MIN_PROTOCOL);
    expect(belowMinimum(PROTOCOL)).toBe(false);
  });

  it("refuses a machine known to be older, never one not yet heard from", () => {
    expect(belowMinimum(MIN_PROTOCOL - 1)).toBe(true);
    expect(belowMinimum(null)).toBe(false);
    expect(protocolRefusal({ hostname: "engage", version: null, protocol: null })).toBeNull();
  });

  it("names the machine and its version in the notice", () => {
    expect(protocolRefusal({ hostname: "engage", version: "0.30.9", protocol: 0 })).toBe(
      "engage runs claude-mux 0.30.9, too old to be reached from here; update engage first"
    );
    expect(protocolRefusal({ hostname: "distilo", version: null, protocol: 0 })).toMatch(/^distilo runs an older claude-mux/);
  });

  it("lets a machine too old through to its health check and its update only", () => {
    const old = { hostname: "engage", version: "0.30.9", protocol: 0 };
    expect(relayRefusal(old, "/api/health")).toBeNull();
    expect(relayRefusal(old, "/api/update")).toBeNull();
    expect(relayRefusal(old, "/api/sessions")).not.toBeNull();
    expect(relayRefusal(old, "/api/update/other")).not.toBeNull();
    expect(relayRefusal(null, "/api/sessions")).toBeNull();
  });
});
