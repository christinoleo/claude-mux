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
  /** Whether the session was waiting on a person. */
  needsYou: boolean;
  /** The latest completion seen. Sticky: the hook clears it when the next turn starts. */
  completion: number | null;
}

export interface SessionNotification<S extends NotifiableSession = NotifiableSession> {
  session: S;
  kind: NotificationKind;
}

export const NOTIFICATION_TITLES: Record<NotificationKind, string> = {
  input: "Input needed",
  approval: "Approval needed",
  completion: "Turn finished",
};

/**
 * Compare a broadcast with what was seen before it. A session raises at most
 * one event per change: one when it starts waiting (a permission dialog that
 * reports as `waiting` and then `permission` is one wait, not two), and one
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
    seen.set(session.id, { needsYou: kind !== null, completion });
    if (!prior || session.pane_alive === false) continue;
    if (kind && !prior.needsYou) {
      events.push({ session, kind });
    } else if (completion !== null && (prior.completion === null || completion > prior.completion)) {
      events.push({ session, kind: "completion" });
    }
  }
  return { seen, events };
}
