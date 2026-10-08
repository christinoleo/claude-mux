import type { Subagent } from "./db/sessions-json.js";

/** How long a finished subagent keeps its own row before it folds into a count. */
export const AGENT_ROW_MS = 10 * 60 * 1000;
/** How long the count remembers it: the hook keeps it this long, but only prunes on its next write. */
export const AGENT_COUNT_MS = 60 * 60 * 1000;

/** What the sidebar draws for one session's subagents. */
export interface AgentView {
  /** Rows to draw, oldest first: running, failed and not yet opened, recently finished. */
  rows: Subagent[];
  running: number;
  /** Done long enough ago that only the parent's status line counts them. */
  folded: number;
}

/**
 * Sorts a session's subagents into rows and a folded count. A failed agent
 * keeps its row until someone opens it; after that it ages like a finished
 * one, but is never counted as done.
 */
export function agentView(agents: Subagent[] | undefined, now: number, opened: ReadonlySet<string>): AgentView {
  const rows: Subagent[] = [];
  let running = 0;
  let folded = 0;
  for (const agent of agents ?? []) {
    if (agent.state === "running") running++;
    const pinned = agent.state === "running" || (agent.state === "failed" && !opened.has(agent.id));
    const ended = agent.ended_at ?? now;
    if (pinned || ended > now - AGENT_ROW_MS) rows.push(agent);
    else if (agent.state === "done" && ended > now - AGENT_COUNT_MS) folded++;
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
