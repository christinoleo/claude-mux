import { describe, it, expect } from "vitest";
import {
  detectNotifications,
  type NotifiableSession,
  type SeenSession,
} from "../../src/session-notifications.js";
import { ASKING, needsYouKind } from "../../src/session-state.js";

function run(broadcasts: NotifiableSession[][]) {
  let seen = new Map<string, SeenSession>();
  const all: Array<[string, string]> = [];
  for (const sessions of broadcasts) {
    const out = detectNotifications(seen, sessions);
    seen = out.seen;
    all.push(...out.events.map((e) => [e.session.id, e.kind] as [string, string]));
  }
  return all;
}

const busy: NotifiableSession = { id: "a", state: "busy", turn_completed_at: null };

describe("detectNotifications", () => {
  it("stays quiet about what was already true when the page opened", () => {
    expect(run([[{ id: "a", state: "permission", turn_completed_at: 5 }]])).toEqual([]);
  });

  it("raises one approval for a permission dialog, through both of its states", () => {
    const events = run([
      [busy],
      [{ ...busy, state: "waiting", current_action: "Waiting..." }],
      [{ ...busy, state: "permission", current_action: "Waiting for permission" }],
      [{ ...busy, state: "permission", current_action: "Waiting for permission" }],
    ]);
    expect(events).toEqual([["a", "approval"]]);
  });

  it("raises again for a second dialog after the first was answered", () => {
    const events = run([
      [busy],
      [{ ...busy, state: "permission" }],
      [busy],
      [{ ...busy, state: "waiting", current_action: ASKING }],
    ]);
    expect(events).toEqual([
      ["a", "approval"],
      ["a", "input"],
    ]);
  });

  it("raises a completion once per finished turn", () => {
    const events = run([
      [busy],
      [{ id: "a", state: "idle", turn_completed_at: 100 }],
      [{ id: "a", state: "idle", turn_completed_at: 100 }],
      // The next prompt clears the stamp; that is not a completion.
      [{ id: "a", state: "busy", turn_completed_at: null }],
      [{ id: "a", state: "idle", turn_completed_at: 200 }],
    ]);
    expect(events).toEqual([
      ["a", "completion"],
      ["a", "completion"],
    ]);
  });

  it("ignores a session whose pane has closed", () => {
    expect(run([[busy], [{ ...busy, state: "permission", pane_alive: false }]])).toEqual([]);
  });

  it("starts tracking a session that appears later without alerting for it", () => {
    const events = run([[busy], [busy, { id: "b", state: "idle", turn_completed_at: 9 }]]);
    expect(events).toEqual([]);
  });
});

describe("needsYouKind", () => {
  it("tells a question from an approval by what the session is doing", () => {
    expect(needsYouKind({ state: "waiting", current_action: ASKING })).toBe("input");
    expect(needsYouKind({ state: "waiting", current_action: "Waiting..." })).toBe("approval");
    expect(needsYouKind({ state: "permission" })).toBe("approval");
    expect(needsYouKind({ state: "idle" })).toBeNull();
  });
});
