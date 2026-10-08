import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getPushSubscriptions,
  getPushSubscription,
  savePushSubscription,
  removePushSubscriptions,
  setPushSubscriptionsPath,
  type PushSubscriptionRecord,
  type Session,
} from "../../src/db/index.js";
import { deliverPush, pushMessageFor, type PushMessage } from "../../src/server/push.js";
import { ASKING } from "../../src/session-state.js";

const dir = join(tmpdir(), `claude-mux-push-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const keys = { p256dh: "p", auth: "a" };
const both = { needsYou: true, done: true };

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

describe("push subscriptions (JSON file)", () => {
  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    setPushSubscriptionsPath(join(dir, "push-subscriptions.json"));
  });
  afterEach(() => {
    setPushSubscriptionsPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty, and subscribing again from a device replaces it", () => {
    expect(getPushSubscriptions()).toEqual([]);
    const first = savePushSubscription({ endpoint: "https://push/1", keys, events: both });
    savePushSubscription({ endpoint: "https://push/2", keys, events: both });
    savePushSubscription({ endpoint: "https://push/1", keys, events: { needsYou: true, done: false } });

    expect(getPushSubscriptions()).toHaveLength(2);
    const again = getPushSubscription("https://push/1");
    expect(again?.events).toEqual({ needsYou: true, done: false });
    expect(again?.created_at).toBe(first.created_at);
  });

  it("forgets the devices it is told to", () => {
    savePushSubscription({ endpoint: "https://push/1", keys, events: both });
    savePushSubscription({ endpoint: "https://push/2", keys, events: both });
    expect(removePushSubscriptions(["https://push/1", "https://push/nope"])).toBe(1);
    expect(getPushSubscriptions().map((s) => s.endpoint)).toEqual(["https://push/2"]);
  });

  it("delivers only to the devices that want the event, and drops the gone ones", async () => {
    savePushSubscription({ endpoint: "https://push/needs", keys, events: { needsYou: true, done: false } });
    savePushSubscription({ endpoint: "https://push/gone", keys, events: both });
    savePushSubscription({ endpoint: "https://push/flaky", keys, events: both });

    const sent: string[] = [];
    const send = async (s: PushSubscriptionRecord, m: PushMessage) => {
      sent.push(`${s.endpoint} ${m.kind}`);
      if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (s.endpoint.endsWith("flaky")) throw Object.assign(new Error("Busy"), { statusCode: 503 });
    };

    expect(await deliverPush(pushMessageFor(session(), "completion"), send)).toBe(1);
    expect(sent.sort()).toEqual(["https://push/flaky completion", "https://push/gone completion"]);
    // A refusal that is not 404/410 is the service's trouble, not the device's.
    expect(getPushSubscriptions().map((s) => s.endpoint).sort()).toEqual(["https://push/flaky", "https://push/needs"]);
  });
});

describe("pushMessageFor", () => {
  it("says what the desktop notification says, and opens the session", () => {
    expect(pushMessageFor(session(), "approval", "Do you want to run rm?")).toEqual({
      title: "Approval needed",
      body: "fix the build\nDo you want to run rm?",
      tag: "abc",
      url: "/session/main%3A1.0",
      kind: "approval",
    });
    expect(pushMessageFor(session(), "approval").body).toBe("fix the build\nAsking permission to go on");
    expect(pushMessageFor(session({ state: "waiting", current_action: ASKING }), "input").body).toBe(
      "fix the build\nAsking a question",
    );
    expect(pushMessageFor(session({ state: "idle", display_name: null }), "completion")).toMatchObject({
      title: "Turn finished",
      body: "main:1.0",
    });
  });
});
