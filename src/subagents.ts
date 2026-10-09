import type { Subagent } from "./db/sessions-json.js";

/** How long the count remembers it: the hook keeps it this long, but only prunes on its next write. */
export const AGENT_COUNT_MS = 60 * 60 * 1000;

/** What the sidebar draws for one session's subagents. */
export interface AgentView {
  /** Rows to draw, oldest first: running, and failed but not yet opened. */
  rows: Subagent[];
  running: number;
  /** Finished agents, which only the parent's status line counts. */
  folded: number;
}

/**
 * Sorts a session's subagents into rows and a folded count. A finished agent
 * folds into the count the moment it ends. A failed agent keeps its row until
 * someone opens it, and is never counted as done.
 */
export function agentView(agents: Subagent[] | undefined, now: number, opened: ReadonlySet<string>): AgentView {
  const rows: Subagent[] = [];
  let running = 0;
  let folded = 0;
  for (const agent of agents ?? []) {
    if (agent.state === "running") running++;
    if (agent.state === "running" || (agent.state === "failed" && !opened.has(agent.id))) rows.push(agent);
    else if (agent.state === "done" && (agent.ended_at ?? now) > now - AGENT_COUNT_MS) folded++;
  }
  rows.sort((a, b) => a.started_at - b.started_at);
  return { rows, running, folded };
}

/** The parent's tally: "1 worker · 2 agents", "3 agents done"; null when there is nothing to say. */
export function childSummary(workers: number, view: AgentView): string | null {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (workers) parts.push(count(workers, "worker"));
  if (view.running) parts.push(count(view.running, "agent"));
  if (view.folded) parts.push(`${count(view.folded, "agent")} done`);
  return parts.length ? parts.join(" · ") : null;
}

/** The agent type as a chip says it: "general-purpose" is just "general". */
export function agentTypeLabel(type: string): string {
  return type.replace(/-purpose$/, "");
}
