import { describe, it, expect } from "vitest";
import { CommitRunCollector } from "../../src/transcript/commits.js";

const at = (iso: string) => Date.parse(iso);
const prompt = (uuid: string, ts: string, text: string) =>
  JSON.stringify({ type: "user", uuid, timestamp: ts, message: { role: "user", content: text } });
const bash = (id: string, ts: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
const result = (id: string, ts: string) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
  });

describe("CommitRunCollector", () => {
  it("claims a commit made while the session was committing, and names its turn", () => {
    const c = new CommitRunCollector();
    c.feed(prompt("turn-1", "2026-10-13T12:00:00Z", "commit and publish"));
    c.feed(bash("t1", "2026-10-13T12:00:10Z", "git add -A && git commit -q -m 'x'"));
    c.feed(result("t1", "2026-10-13T12:00:12Z"));
    expect(c.runAt(at("2026-10-13T12:00:11Z"))).toMatchObject({ turn: "turn-1" });
    expect(c.runAt(at("2026-10-13T12:05:00Z"))).toBeNull();
  });

  it("does not take a run of some other git command for a commit", () => {
    const c = new CommitRunCollector();
    c.feed(prompt("turn-1", "2026-10-13T12:00:00Z", "look"));
    c.feed(bash("t1", "2026-10-13T12:00:10Z", "git status --short && git log --oneline -3"));
    c.feed(result("t1", "2026-10-13T12:00:12Z"));
    expect(c.runAt(at("2026-10-13T12:00:11Z"))).toBeNull();
  });

  it("counts the release script, and a run whose result has not come back yet", () => {
    const c = new CommitRunCollector();
    c.feed(prompt("turn-2", "2026-10-13T13:00:00Z", "release it"));
    c.feed(bash("t2", "2026-10-13T13:00:05Z", "npm version patch"));
    expect(c.runAt(at("2026-10-13T13:00:06Z"))).toMatchObject({ turn: "turn-2", to: null });
  });
});
