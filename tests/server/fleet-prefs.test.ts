import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetPrefsStore } from "../../src/server/fleet-prefs.js";
import { FleetState, type PeerHandlers, type PeerLink } from "../../src/server/fleet-state.js";

/**
 * Fleet preferences across machines: each machine's store, written by its
 * pages and merged with what its peers' sockets send, and what lands on disk.
 */

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-prefs-"));
  clock = 1_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(selfId: string, path: string | null = null) {
  return new FleetPrefsStore({ selfId, path, now: () => clock });
}

describe("FleetPrefsStore", () => {
  it("stamps a page's write with this machine and its clock, and tells subscribers", () => {
    const prefs = store("omarchy");
    let heard = 0;
    prefs.subscribe(() => heard++);
    expect(prefs.set("fold:project:omarchy:/p", true)).toBe(true);
    expect(prefs.all()).toEqual({ "fold:project:omarchy:/p": { value: true, at: 1_000, by: "omarchy" } });
    expect(heard).toBe(1);
  });

  it("keeps the push keys among the servers: a page is sent the set without them", () => {
    const prefs = store("omarchy");
    prefs.set("rail-order", ["a"]);
    prefs.merge({ "push:vapid": { value: { publicKey: "p", privateKey: "k" }, at: 1, by: "engage" } });
    prefs.set("push:sub:https://push/1", null);
    expect(Object.keys(prefs.all()).sort()).toEqual(["push:sub:https://push/1", "push:vapid", "rail-order"]);
    expect(Object.keys(prefs.forPages())).toEqual(["rail-order"]);
  });

  it("refuses a key or value it cannot keep", () => {
    const prefs = store("omarchy");
    expect(prefs.set("", true)).toBe(false);
    expect(prefs.set("k", undefined)).toBe(false);
    expect(prefs.all()).toEqual({});
  });

  it("puts a write after the one it replaces when this clock runs behind", () => {
    const prefs = store("omarchy");
    prefs.merge({ k: { value: "engage's", at: 5_000, by: "engage" } });
    prefs.set("k", "mine");
    expect(prefs.all().k).toEqual({ value: "mine", at: 5_001, by: "omarchy" });
  });

  it("is quiet about a merge that brings nothing newer", () => {
    const prefs = store("omarchy");
    prefs.set("k", 1);
    let heard = 0;
    prefs.subscribe(() => heard++);
    expect(prefs.merge({ k: { value: 0, at: 1, by: "engage" } })).toBe(false);
    expect(prefs.merge(prefs.all())).toBe(false);
    expect(heard).toBe(0);
  });

  it("keeps the set on disk and reads it back on start", () => {
    const path = join(dir, "fleet-prefs.json");
    store("omarchy", path).set("machine-filter", "engage-id");
    expect(JSON.parse(readFileSync(path, "utf8")).prefs["machine-filter"].value).toBe("engage-id");
    expect(store("omarchy", path).all()["machine-filter"]).toEqual({ value: "engage-id", at: 1_000, by: "omarchy" });
  });

  it("starts empty from a file that is missing or broken", () => {
    expect(store("omarchy", join(dir, "nope.json")).all()).toEqual({});
  });
});

/**
 * Three machines wired as the servers wire them: each one's fleet state
 * follows the others' sessions sockets, and each socket sends its machine's
 * preferences on connect and after every change.
 */
function fleetOf(ids: string[]) {
  const prefs = new Map(ids.map((id) => [id, store(id)]));
  const followers = new Map<string, PeerHandlers[]>(ids.map((id) => [id, []]));
  const states = ids.map((id) => {
    const mine = prefs.get(id)!;
    return new FleetState({
      selfId: id,
      path: null,
      version: async () => null,
      prefs: (incoming) => mine.merge(incoming),
      connect(url: string, handlers: PeerHandlers): PeerLink {
        const followed = url.replace("https://", "");
        followers.get(followed)!.push(handlers);
        queueMicrotask(() => {
          handlers.open();
          handlers.message(JSON.stringify({ type: "prefs", prefs: prefs.get(followed)!.all() }));
        });
        return { send() {}, close() {} };
      },
    });
  });
  for (const id of ids) {
    prefs.get(id)!.subscribe(() => {
      const message = JSON.stringify({ type: "prefs", prefs: prefs.get(id)!.all() });
      for (const handlers of followers.get(id)!) handlers.message(message);
    });
  }
  const connect = async () => {
    for (const s of states) s.update(ids.map((id) => ({ id, hostname: id, url: `https://${id}` })));
    await new Promise((r) => setTimeout(r, 0));
  };
  const stop = () => states.forEach((s) => s.stop());
  return { prefs, connect, stop };
}

describe("fleet preferences across machines", () => {
  it("spreads a fold made on one machine to every other", async () => {
    const fleet = fleetOf(["omarchy", "engage", "distilo"]);
    await fleet.connect();
    fleet.prefs.get("omarchy")!.set("fold:project:engage:/p", true);
    for (const p of fleet.prefs.values()) expect(p.all()["fold:project:engage:/p"]?.value).toBe(true);
    fleet.stop();
  });

  it("converges two machines changing the same preference on the later write", async () => {
    const fleet = fleetOf(["omarchy", "engage", "distilo"]);
    fleet.prefs.get("omarchy")!.set("machine-filter", "all");
    clock = 2_000;
    fleet.prefs.get("engage")!.set("machine-filter", "distilo");
    await fleet.connect();
    for (const p of fleet.prefs.values()) {
      expect(p.all()["machine-filter"]).toEqual({ value: "distilo", at: 2_000, by: "engage" });
    }
    fleet.stop();
  });

  it("brings a machine that was away up to date when it connects", async () => {
    const fleet = fleetOf(["omarchy", "engage"]);
    fleet.prefs.get("omarchy")!.set("fold:machine:engage", false);
    expect(fleet.prefs.get("engage")!.all()).toEqual({});
    await fleet.connect();
    expect(fleet.prefs.get("engage")!.all()["fold:machine:engage"]?.value).toBe(false);
    fleet.stop();
  });
});

describe("two servers sharing one file", () => {
  it("keep each other's writes when either writes", () => {
    const path = join(dir, "fleet-prefs.json");
    const prod = store("omarchy", path);
    const dev = store("omarchy", path);
    dev.set("fold:project:omarchy:/a", true);
    clock = 2_000;
    prod.set("fold:project:omarchy:/b", true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")).prefs;
    expect(Object.keys(onDisk).sort()).toEqual(["fold:project:omarchy:/a", "fold:project:omarchy:/b"]);
  });
});
