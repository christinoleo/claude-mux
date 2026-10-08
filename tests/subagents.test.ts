import { describe, it, expect } from "vitest";
import { agentView, childSummary, agentTypeLabel, AGENT_ROW_MS } from "../src/subagents.js";
import type { Subagent } from "../src/db/sessions-json.js";

const NOW = 1_000_000_000;

function agent(id: string, state: Subagent["state"], endedAgo: number | null, startedAt = 0): Subagent {
  return {
    id,
    type: "Explore",
    description: id,
    state,
    started_at: startedAt,
    ended_at: endedAgo === null ? null : NOW - endedAgo,
    transcript_path: null,
  };
}

describe("agentView", () => {
  it("draws running and recently finished agents, and folds the rest into a count", () => {
    const view = agentView(
      [agent("run", "running", null, 3), agent("fresh", "done", 60_000, 2), agent("stale", "done", AGENT_ROW_MS + 1, 1)],
      NOW,
      new Set()
    );
    expect(view.rows.map((a) => a.id)).toEqual(["fresh", "run"]);
    expect(view).toMatchObject({ running: 1, folded: 1 });
  });

  it("keeps a failed agent's row until it is opened, then lets it age", () => {
    const failed = [agent("bad", "failed", AGENT_ROW_MS * 3)];
    expect(agentView(failed, NOW, new Set()).rows.map((a) => a.id)).toEqual(["bad"]);
    expect(agentView(failed, NOW, new Set(["bad"]))).toMatchObject({ rows: [], folded: 0 });
  });

  it("stops counting a done agent after an hour, though the hook has not pruned it yet", () => {
    expect(agentView([agent("old", "done", 61 * 60 * 1000)], NOW, new Set()).folded).toBe(0);
  });

  it("handles a session with no subagents", () => {
    expect(agentView(undefined, NOW, new Set())).toEqual({ rows: [], running: 0, folded: 0 });
  });
});

describe("childSummary", () => {
  it("reads like the design's status line", () => {
    expect(childSummary(1, { rows: [], running: 2, folded: 0 })).toBe("1 worker · 2 agents");
    expect(childSummary(0, { rows: [], running: 0, folded: 3 })).toBe("3 agents done");
    expect(childSummary(2, { rows: [], running: 1, folded: 1 })).toBe("2 workers · 1 agent · 1 agent done");
    expect(childSummary(0, { rows: [], running: 0, folded: 0 })).toBeNull();
  });
});

describe("agentTypeLabel", () => {
  it("shortens general-purpose and leaves the rest", () => {
    expect(agentTypeLabel("general-purpose")).toBe("general");
    expect(agentTypeLabel("Explore")).toBe("Explore");
  });
});
