import type { Subagent } from "./db/sessions-json.js";

/** How long a finished subagent keeps its own row before it folds into a count. */
export const AGENT_ROW_MS = 10 * 60 * 1000;

/** What the sidebar draws for one session's subagents. */
export interface AgentView {
  /** Rows to draw, oldest first: running, failed and not yet opened, recently finished. */
  rows: Subagent[];
  running: number;
  /** Finished long enough ago that only the parent's status line counts them. */
  folded: number;
}

/**
 * Sorts a session's subagents into rows and a folded count. A failed agent
 * keeps its row until someone opens it; after that it ages like a finished one.
 */
export function agentView(agents: Subagent[] | undefined, now: number, opened: ReadonlySet<string>): AgentView {
  const rows: Subagent[] = [];
  let running = 0;
  let folded = 0;
  for (const agent of agents ?? []) {
    if (agent.state === "running") running++;
    const pinned = agent.state === "running" || (agent.state === "failed" && !opened.has(agent.id));
    if (pinned || (agent.ended_at ?? now) > now - AGENT_ROW_MS) rows.push(agent);
    else folded++;
  }
  rows.sort((a, b) => a.started_at - b.started_at);
  return { rows, running, folded };
}

/** The parent's tally: "1 worker · 2 agents", "3 agents done"; null when there is nothing to say. */
export function childSummary(workers: number, view: AgentView): string | null {
  const parts: string[] = [];
  if (workers) parts.push(`${workers} worker${workers === 1 ? "" : "s"}`);
  if (view.running) parts.push(`${view.running} agent${view.running === 1 ? "" : "s"}`);
  if (view.folded) parts.push(`${view.folded} agent${view.folded === 1 ? "" : "s"} done`);
  return parts.length ? parts.join(" · ") : null;
}

/** The agent type as a chip says it: "general-purpose" is just "general". */
export function agentTypeLabel(type: string): string {
  return type.replace(/-purpose$/, "");
}
