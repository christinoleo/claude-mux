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

/**
 * A row can also be in states Claude Code never reports: `done` is an idle
 * session whose last turn ended after anyone last looked (see `isUnread`).
 */
export type IndicatorState = SessionState | "done" | "dead" | "plain";

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
  // The one idle with colour: a turn finished while nobody was looking.
  done: {
    icon: "mdi:check-circle",
    color: "#34d399",
    ink: "green",
    emoji: "✅",
    pulse: false,
    label: "Done",
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

/** The fields the unread "Done" is worked out from. */
export interface TurnWatermark {
  state: SessionState;
  /** Stamped by the hook when a turn ends for good. */
  turn_completed_at?: number | null;
  /** The server's visits watermark; null when nobody ever opened the session. */
  last_visited_at?: number | null;
}

/**
 * A turn ended after the last time anyone looked. A session never visited
 * counts as read — otherwise every session alive when this shipped, and every
 * worker nobody opens, would light up at once.
 */
export function isUnread(s: TurnWatermark): boolean {
  if (!s.turn_completed_at || !s.last_visited_at) return false;
  return s.turn_completed_at > s.last_visited_at;
}

/** What a live session's indicator shows: its state, or `done` for an unread idle. */
export function indicatorStateOf(s: TurnWatermark): IndicatorState {
  return s.state === "idle" && isUnread(s) ? "done" : s.state;
}

/**
 * A row that needs nothing from anyone steps back: a dimmer title, so working,
 * asking and done sessions are what the eye lands on. Adapted from t3code's
 * `shouldRecedeSidebarThread` (MIT, © T3 Tools Inc.).
 */
export function recedes(state: IndicatorState): boolean {
  return state === "idle" || state === "dead" || state === "plain";
}

/** What a session asking through AskUserQuestion is doing, as its row says it. */
export const ASKING = "Asking a question";
/** What a session waiting on an MCP elicitation is doing. */
export const AWAITING_INPUT = "Waiting for input";

/**
 * What a session wants from a person: an answer, an approval, or nothing.
 * A permission dialog reports as `waiting` first (the PermissionRequest hook)
 * and turns `permission` only when Claude Code's notification follows, so the
 * action, not the state, is what tells a question from an approval.
 */
export function needsYouKind(s: {
  state: SessionState;
  current_action?: string | null;
}): "input" | "approval" | null {
  if (s.state === "permission") return "approval";
  if (s.state !== "waiting") return null;
  return s.current_action === ASKING || s.current_action === AWAITING_INPUT ? "input" : "approval";
}
