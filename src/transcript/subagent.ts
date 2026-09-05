/**
 * Shaping a subagent's transcript for display: what it ran, what it reported,
 * and whether it is still working. Lives beside the parser rather than in the
 * WebSocket layer — it is transcript logic, not transport.
 */
import type { SubagentMeta } from "./tailer.js";
import type { JsonlTailer } from "./tailer.js";
import type { TranscriptBuilder } from "./parser.js";

/** What the manager holds per subagent; only these fields are read here. */
export interface SubagentSource {
  tailer: Pick<JsonlTailer, "mtimeMs">;
  builder: Pick<TranscriptBuilder, "entries">;
  meta: SubagentMeta;
}

/**
 * A subagent's work, condensed for the Task card that spawned it: what it ran
 * (summaries only — the parent card doesn't need every tool's full input) plus
 * the report it returned.
 */
export interface SubagentPayload {
  agentId: string;
  /** Parent Task tool_use id — the card this belongs under. */
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  model: string | null;
  activity: { id: string; name: string; summary: string; ok: boolean | null }[];
  /** Older activity entries dropped from the list above. */
  trimmed: number;
  /** The subagent's final message: what it reported back. */
  report: string | null;
  running: boolean;
  /**
   * Whether this carries the whole activity list and the report. A lean
   * payload has the tail of the activity only; the full one is sent when a
   * reader opens the card.
   */
  full: boolean;
}

/** Longest activity list sent per subagent; real agents reach 150+ tools. */
export const SUBAGENT_ACTIVITY_LIMIT = 120;
/**
 * What a card that nobody has opened carries: enough to say what the agent
 * is doing now. A session with forty agents was sending forty lists of a
 * hundred calls in every snapshot, most of them inside closed cards.
 */
export const SUBAGENT_ACTIVITY_LEAN = 8;

/**
 * Fallback liveness window, used only until the harness reports the agent as
 * finished (see TranscriptBuilder.finishedAgents). Covers the gap for agents
 * whose notification never arrives — the launching tool call returns
 * immediately for background agents, so writes are the only other signal.
 */
const SUBAGENT_LIVE_WINDOW_MS = 45_000;

/** Condense a subagent's parsed transcript into what its Task card shows. */
export function subagentPayload(
  agentId: string,
  state: SubagentSource,
  finished: boolean,
  full = true
): SubagentPayload {
  const limit = full ? SUBAGENT_ACTIVITY_LIMIT : SUBAGENT_ACTIVITY_LEAN;
  const activity: SubagentPayload['activity'] = [];
  let report: string | null = null;
  for (const entry of state.builder.entries) {
    if (entry.kind === 'tool') {
      activity.push({
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        ok: entry.result ? entry.result.ok : null
      });
    } else if (entry.kind === 'text') {
      report = entry.text;
    }
  }
  const mtime = state.tailer.mtimeMs();
  const running =
    !finished && mtime !== null && Date.now() - mtime < SUBAGENT_LIVE_WINDOW_MS;
  const trimmed = Math.max(0, activity.length - limit);
  return {
    agentId,
    toolUseId: state.meta.toolUseId ?? null,
    agentType: state.meta.agentType ?? null,
    description: state.meta.description ?? null,
    model: state.meta.model ?? null,
    // Keep the newest calls — the tail is what "what is it doing" needs.
    activity: activity.slice(-limit),
    trimmed,
    report: full ? report : null,
    running,
    full
  };
}

/**
 * Streams parsed session transcripts (from ~/.claude/projects JSONL files) to
 * clients, keyed by claude-mux session id. Mirrors TerminalWsManager's
 * lifecycle: first client for a session starts the tailer, last one stops it.
 */
