import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Session } from "../../src/db/index.js";
import type { PushSubscriptionRecord } from "../../src/fleet-push.js";
import { FleetPrefsStore } from "../../src/server/fleet-prefs.js";
import { FleetPush } from "../../src/server/fleet-push.js";
import { deliverPush, pushMessageFor, type PushMessage } from "../../src/server/push.js";
import { ASKING } from "../../src/session-state.js";

const keys = { p256dh: "p", auth: "a" };
const both = { needsYou: true, done: true };
const pair = (name: string) => ({ publicKey: `${name}-public`, privateKey: `${name}-private` });

function session(over: Partial<Session> = {}): Session {
  return {
    id: "abc",
    tmux_target: "main:1.0",
    display_name: "fix the build",
    state: "permission",
    current_action: "Waiting for permission",
    git_root: null,
    maestro_issue: null,
    ...over,
  } as Session;
}

let clock: number;
let dir: string;

beforeEach(() => {
  clock = 1_000;
  dir = mkdtempSync(join(tmpdir(), "claude-mux-push-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One machine's push, over its own fleet preferences. */
function machine(id: string) {
  const prefs = new FleetPrefsStore({ selfId: id, path: null, now: () => clock });
  return { prefs, push: new FleetPush(prefs, id, () => clock) };
}

/** What one machine's sessions socket hands a peer, merged as the fleet state merges it. */
function spread(from: FleetPrefsStore, to: FleetPrefsStore): void {
  to.merge(JSON.parse(JSON.stringify(from.all())));
}

describe("push across the fleet", () => {
  it("a device subscribed through one machine is on every machine's list, and forgotten everywhere", () => {
    const omarchy = machine("omarchy");
    const distilo = machine("distilo");
    omarchy.push.offerKeys(pair("fleet"), 10);
    spread(omarchy.prefs, distilo.prefs);

    omarchy.push.save({ endpoint: "https://push/phone", keys, events: both, vapid: "fleet-public" });
    spread(omarchy.prefs, distilo.prefs);
    expect(distilo.push.subscriptions().map((s) => s.endpoint)).toEqual(["https://push/phone"]);

    clock = 2_000;
    expect(distilo.push.forget(["https://push/phone", "https://push/nope"])).toBe(1);
    spread(distilo.prefs, omarchy.prefs);
    expect(omarchy.push.subscriptions()).toEqual([]);
  });

  it("subscribing again from a device replaces it and keeps when it first subscribed", () => {
    const { push } = machine("omarchy");
    push.offerKeys(pair("fleet"), 10);
    const first = push.save({ endpoint: "https://push/1", keys, events: both, vapid: "fleet-public" });
    clock = 5_000;
    push.save({ endpoint: "https://push/1", keys, events: { needsYou: true, done: false }, vapid: "fleet-public" });
    expect(push.get("https://push/1")).toMatchObject({ events: { needsYou: true, done: false }, created_at: first.created_at });
  });

  it("keeps the first key pair made, whichever order the machines hear of them", () => {
    const omarchy = machine("omarchy");
    const engage = machine("engage");
    engage.push.offerKeys(pair("engage"), 500);
    omarchy.push.offerKeys(pair("omarchy"), 100);
    spread(engage.prefs, omarchy.prefs);
    spread(omarchy.prefs, engage.prefs);
    expect(omarchy.push.keys()).toEqual(pair("omarchy"));
    expect(engage.push.keys()).toEqual(pair("omarchy"));
  });

  it("makes a pair only when no machine holds one", () => {
    const { push } = machine("omarchy");
    let made = 0;
    const generate = () => (made++, pair("new"));
    expect(push.ensureKeys(generate)).toEqual(pair("new"));
    expect(push.ensureKeys(generate)).toEqual(pair("new"));
    expect(made).toBe(1);
  });

  it("reaches only the devices subscribed under the fleet's key", () => {
    const { push } = machine("omarchy");
    push.offerKeys(pair("fleet"), 10);
    push.save({ endpoint: "https://push/new", keys, events: both, vapid: "fleet-public" });
    push.save({ endpoint: "https://push/old", keys, events: both, vapid: "engage-public" });
    expect(push.subscriptions().map((s) => s.endpoint)).toEqual(["https://push/new"]);
    // The page still finds the old one, to subscribe it again under the fleet's key.
    expect(push.get("https://push/old")?.vapid).toBe("engage-public");
  });

  it("brings in the key and devices a machine kept before, without undoing what the fleet decided", () => {
    const vapid = join(dir, "vapid.json");
    const subs = join(dir, "push-subscriptions.json");
    writeFileSync(vapid, JSON.stringify(pair("local")));
    utimesSync(vapid, 50, 50);
    const old = (endpoint: string) => ({ endpoint, keys, events: both, created_at: 7 });
    writeFileSync(subs, JSON.stringify([old("https://push/a"), old("https://push/b"), { endpoint: 1 }]));

    const { push } = machine("engage");
    push.offerKeys(pair("older"), 10);
    push.save({ endpoint: "https://push/b", keys, events: both, vapid: "older-public" });
    push.forget(["https://push/b"]);
    push.importLocal(vapid, subs);

    expect(push.keys()).toEqual(pair("older"));
    expect(push.get("https://push/a")).toMatchObject({ vapid: "local-public", created_at: 7 });
    expect(push.get("https://push/b")).toBeNull();
  });

  it("a machine's own older key takes over the fleet", () => {
    const vapid = join(dir, "vapid.json");
    writeFileSync(vapid, JSON.stringify(pair("local")));
    utimesSync(vapid, 5, 5);
    const { push } = machine("engage");
    push.offerKeys(pair("newer"), 9_000);
    push.importLocal(vapid, join(dir, "none.json"));
    expect(push.keys()).toEqual(pair("local"));
  });

  it("delivers only to the devices that want the event, and forgets the gone ones", async () => {
    const { push } = machine("omarchy");
    push.offerKeys(pair("fleet"), 10);
    const sub = (endpoint: string, events = both) => push.save({ endpoint, keys, events, vapid: "fleet-public" });
    sub("https://push/needs", { needsYou: true, done: false });
    sub("https://push/gone");
    sub("https://push/flaky");

    const sent: string[] = [];
    const send = async (s: PushSubscriptionRecord, m: PushMessage) => {
      sent.push(`${s.endpoint} ${m.kind}`);
      if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (s.endpoint.endsWith("flaky")) throw Object.assign(new Error("Busy"), { statusCode: 503 });
    };
    const devices = { subscriptions: () => push.subscriptions(), forget: (e: string[]) => push.forget(e) };

    expect(await deliverPush(pushMessageFor(session(), "completion", "omarchy"), send, devices)).toBe(1);
    expect(sent.sort()).toEqual(["https://push/flaky completion", "https://push/gone completion"]);
    // A refusal that is not 404/410 is the service's trouble, not the device's.
    expect(push.subscriptions().map((s) => s.endpoint).sort()).toEqual(["https://push/flaky", "https://push/needs"]);
  });
});

describe("pushMessageFor", () => {
  const host = "distilo";

  it("names the session in the title, says where it lives, and opens it", () => {
    const named = session({ git_root: "/home/leo/Projects/zapSell" });
    expect(pushMessageFor(named, "approval", host, "Do you want to run rm?")).toEqual({
      title: "Approval needed: fix the build",
      body: `Do you want to run rm?\nzapSell · ${host}`,
      tag: "abc",
      // Relative, so it opens on the page the device subscribed through, naming the session's machine.
      url: "/m/distilo/session/main%3A1.0",
      kind: "approval",
    });
    expect(pushMessageFor(session(), "approval", host).body).toBe(`Asking permission to go on\n${host}`);
    expect(pushMessageFor(session({ state: "waiting", current_action: ASKING }), "input", host).body).toBe(
      `Asking a question\n${host}`,
    );
  });

  it("calls a session nobody named by its project, not by its tmux target", () => {
    const unnamed = session({ state: "idle", display_name: null, cwd: "/home/leo/Projects/zapSell/.worktree/105" });
    expect(pushMessageFor(unnamed, "completion", host)).toMatchObject({ title: "Turn finished: zapSell", body: host });
    expect(pushMessageFor(session({ state: "idle", display_name: null }), "completion", host).title).toBe(
      "Turn finished: main:1.0",
    );
  });
});
