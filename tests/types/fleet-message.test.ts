import { describe, expect, it } from "vitest";
import { SessionsWsMessageSchema } from "../../src/types/ws-messages.js";

const good = { v: 1, id: "a", pid: 1, cwd: "/p", state: "idle", last_update: 1, pane_alive: true, pane_title: "t",
  git_root: null, tmux_target: "main:1.0", current_action: null, prompt_text: null };

describe("the fleet message", () => {
  it("keeps a machine whose sessions it partly cannot read, dropping only those", () => {
    const parsed = SessionsWsMessageSchema.parse({
      type: "fleet",
      self: "me",
      timestamp: 1,
      machines: [
        {
          id: "engage",
          hostname: "engage",
          url: "https://engage:3456",
          online: true,
          lastSeen: 1,
          retryAt: null,
          version: null,
          sessions: [good, { ...good, id: "b", state: "a-state-from-the-future" }],
          projects: ["/p"],
          inbox: [{ nonsense: true }],
        },
      ],
    });
    expect(parsed.type).toBe("fleet");
    if (parsed.type !== "fleet") return;
    expect(parsed.machines[0].sessions.map((s) => s.id)).toEqual(["a"]);
    expect(parsed.machines[0].inbox).toEqual([]);
  });
});
