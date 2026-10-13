/**
 * Which session changes are worth interrupting someone for. The browser keeps
 * what it last saw of each session and feeds every broadcast through
 * `detectNotifications`, which says what just happened: a session started
 * waiting on a person, or a turn finished.
 *
 * Adapted from t3code's ThreadNotificationCoordinator (MIT, © T3 Tools Inc.).
 */
import type { SessionState } from "./db/index.js";
import { needsYouKind } from "./session-state.js";

export type NotificationKind = "input" | "approval" | "completion";

export interface NotifiableSession {
  id: string;
  state: SessionState;
  current_action?: string | null;
  turn_completed_at?: number | null;
  pane_alive?: boolean;
}

export interface SeenSession {
  /** What the session was waiting on a person for, if anything. */
  needsYou: "input" | "approval" | null;
  /** The latest completion seen. Sticky: the hook clears it when the next turn starts. */
  completion: number | null;
}

export interface SessionNotification<S extends NotifiableSession = NotifiableSession> {
  session: S;
  kind: NotificationKind;
}

const NOTIFICATION_TITLES: Record<NotificationKind, string> = {
  input: "Input needed",
  approval: "Approval needed",
  completion: "Turn finished",
};

/** What a notification calls a session. */
export function sessionDisplayName(s: {
  id: string;
  display_name?: string | null;
  tmux_target?: string | null;
  issue?: { title: string } | null;
}): string {
  // A maestro worker exists to close one issue; its title says what it is
  // doing better than any name the session picked up on the way.
  if (s.issue) return s.issue.title;
  return s.display_name || s.tmux_target || s.id;
}

/**
 * What a waiting session is asking, in the fewest words there are: the
 * dialog's own question when the pane has been read, else what the hooks say.
 */
export function asking(s: {
  state: SessionState;
  current_action?: string | null;
  pane_choice?: { question: string | null } | null;
}): string {
  if (needsYouKind(s) === "input") return s.pane_choice?.question || s.current_action || "Asking you a question";
  // A permission dialog's action is only "Waiting..." or "Waiting for
  // permission", which says less than the dialog's own question.
  return s.pane_choice?.question || "Asking permission to go on";
}

/** The project a session works in, by its folder: the repo, not a worktree inside it. */
function projectOf(s: { git_root?: string | null; cwd?: string | null }): string | null {
  const root = (s.git_root ?? s.cwd ?? "").replace(/\/\.worktrees?\/.*$/, "").replace(/\/+$/, "");
  return root.split("/").pop() || null;
}

/**
 * What a notification says, wherever it is shown: a system notification from
 * the page, a toast, or a push on a phone with no tab open. The title has to
 * stand alone on a lock screen, so it names what happened and to which
 * session; the body adds the question being asked, and where the session
 * lives. A session nobody named is called by its project rather than by its
 * tmux target, which reads as noise, and the machine is said because the same
 * project is often open on more than one.
 */
export function notificationText(
  s: {
    id: string;
    state: SessionState;
    display_name?: string | null;
    tmux_target?: string | null;
    git_root?: string | null;
    cwd?: string | null;
    issue?: { title: string } | null;
    current_action?: string | null;
    pane_choice?: { question: string | null } | null;
  },
  kind: NotificationKind,
  host: string | null,
): { title: string; body: string } {
  const name = s.issue?.title || s.display_name || null;
  const project = projectOf(s);
  const where = [name ? project : null, host].filter(Boolean).join(" · ");
  const more = kind === "completion" ? null : asking(s);
  return {
    title: `${NOTIFICATION_TITLES[kind]}: ${name ?? project ?? s.tmux_target ?? s.id}`,
    body: [more, where].filter(Boolean).join("\n"),
  };
}

/**
 * Compare a broadcast with what was seen before it. A session raises at most
 * one event per change: one when it starts waiting or what it waits for
 * changes (a permission dialog that reports as `waiting` and then `permission`
 * is one wait, not two, but a question answered straight into a permission
 * dialog between two polls is two), and one
 * per completion stamp. A session seen for the first time raises nothing, so
 * opening the page does not replay what already happened.
 */
export function detectNotifications<S extends NotifiableSession>(
  previous: ReadonlyMap<string, SeenSession>,
  sessions: readonly S[],
): { seen: Map<string, SeenSession>; events: SessionNotification<S>[] } {
  const seen = new Map<string, SeenSession>();
  const events: SessionNotification<S>[] = [];
  for (const session of sessions) {
    const prior = previous.get(session.id);
    const kind = needsYouKind(session);
    const completion = session.turn_completed_at ?? prior?.completion ?? null;
    seen.set(session.id, { needsYou: kind, completion });
    if (!prior || session.pane_alive === false) continue;
    if (kind && kind !== prior.needsYou) {
      events.push({ session, kind });
    } else if (completion !== null && (prior.completion === null || completion > prior.completion)) {
      events.push({ session, kind: "completion" });
    }
  }
  return { seen, events };
}
