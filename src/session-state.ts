/**
 * One definition of what a session state looks like, for every surface that
 * draws one: the web sidebar, the transcript's live status row, the session
 * header, and the Ink TUI.
 *
 * These drifted apart repeatedly — a pulsing dot and amber attention icons in
 * the transcript, a flat coloured dot (or whatever glyph tmux happened to leave
 * in the pane title) in the sidebar, and a third palette in the TUI. Add a
 * state here, not in a component.
 */
import type { SessionState } from "./db/index.js";

/** A row can also be in states Claude Code never reports. */
export type IndicatorState = SessionState | "dead" | "plain";

export interface SessionStateVisual {
  /** Iconify name, or null when the state is drawn as a dot. */
  icon: string | null;
  /** Web hex. */
  color: string;
  /** Ink colour name for the TUI, which has no truecolor guarantee. */
  ink: string;
  /** Browser-tab prefix: the state has to survive being one glyph wide. */
  emoji: string;
  /** Dots only: animate to say "something is happening right now". */
  pulse: boolean;
  label: string;
}

export const SESSION_STATE_VISUALS: Record<IndicatorState, SessionStateVisual> = {
  busy: { icon: null, color: "#34d399", ink: "green", emoji: "🟢", pulse: true, label: "Working" },
  permission: {
    icon: "mdi:shield-alert-outline",
    color: "#fbbf24",
    ink: "yellow",
    emoji: "🛡️",
    pulse: false,
    label: "Needs permission",
  },
  waiting: {
    icon: "mdi:chat-question-outline",
    color: "#fbbf24",
    ink: "yellow",
    emoji: "❓",
    pulse: false,
    label: "Waiting for you",
  },
  // Idle recedes on purpose: amber is reserved for the states that want a human.
  idle: { icon: null, color: "#78716c", ink: "gray", emoji: "💤", pulse: false, label: "Idle" },
  dead: { icon: null, color: "#555", ink: "gray", emoji: "⚫", pulse: false, label: "Pane closed" },
  plain: { icon: null, color: "#888", ink: "gray", emoji: "🖥️", pulse: false, label: "Terminal pane" },
};

export function sessionStateVisual(state: IndicatorState): SessionStateVisual {
  // Session JSON on disk can carry a state this build doesn't know — an older
  // hook, a hand-edited file. Render the row quietly rather than throwing.
  return SESSION_STATE_VISUALS[state] ?? SESSION_STATE_VISUALS.idle;
}
