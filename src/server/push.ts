/**
 * Web Push: the server's side of notifying a phone with claude-mux closed.
 *
 * The browser alerts (`NotificationCoordinator.svelte`) only fire while a tab
 * is open, so the events behind a push are detected here instead, off the
 * session JSON the hooks write. It is the same `detectNotifications()` the
 * page runs, fed from the file watcher, so a push says what a desktop
 * notification would. Encryption and the push service's protocol stay behind
 * `PushSend`, which the web server provides with its VAPID keys.
 */

import {
  getAllSessions,
  getPushSubscriptions,
  getSession,
  removePushSubscriptions,
  type PushEvents,
  type PushSubscriptionRecord,
  type Session,
} from "../db/index.js";
import {
  asking,
  detectNotifications,
  NOTIFICATION_TITLES,
  sessionDisplayName,
  type NotificationKind,
  type SeenSession,
} from "../session-notifications.js";
import { capturePaneContentAsync, readPromptOptions } from "../tmux/pane.js";
import { issueFor, watchSessionRepos } from "./github.js";
import { sessionWatcher } from "./watcher.js";

/** What the service worker receives, and shows as is. */
export interface PushMessage {
  title: string;
  body: string;
  /** The session id: a newer push about the same session replaces the older one. */
  tag: string;
  /** Where tapping it goes, relative to the server. */
  url: string;
  kind: NotificationKind;
}

/** Hand one message to one device's push service. Rejects with a `statusCode` when the service refuses. */
export type PushSend = (subscription: PushSubscriptionRecord, message: PushMessage) => Promise<unknown>;

/** The push service no longer knows the device: it unsubscribed, or the browser was reset. */
export function isGone(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || status === 410;
}

function wantsEvent(events: PushEvents, kind: NotificationKind): boolean {
  return kind === "completion" ? events.done : events.needsYou;
}

/** The notification for one event, in the desktop notification's words. */
export function pushMessageFor(
  session: Session,
  kind: NotificationKind,
  question: string | null = null,
): PushMessage {
  const name = sessionDisplayName({ ...session, issue: issueFor(session.git_root, session.maestro_issue) });
  const more = kind === "completion" ? null : asking({ ...session, pane_choice: { question } });
  return {
    title: NOTIFICATION_TITLES[kind],
    body: more ? `${name}\n${more}` : name,
    tag: session.id,
    url: `/session/${encodeURIComponent(session.tmux_target ?? session.id)}`,
    kind,
  };
}

/**
 * Send to every device that wants this kind of event, and forget the devices
 * whose push service says they are gone. Returns how many were forgotten.
 */
export async function deliverPush(
  message: PushMessage,
  send: PushSend,
  subscriptions: PushSubscriptionRecord[] = getPushSubscriptions(),
): Promise<number> {
  const targets = subscriptions.filter((s) => wantsEvent(s.events, message.kind));
  const results = await Promise.allSettled(targets.map((s) => send(s, message)));
  const gone: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") return;
    if (isGone(result.reason)) gone.push(targets[i].endpoint);
    else console.warn("[push] Send failed", { endpoint: targets[i].endpoint, error: String(result.reason) });
  });
  return gone.length > 0 ? removePushSubscriptions(gone) : 0;
}

/** How often the monitor reminds the GitHub cache which repos and issues it needs. */
const ISSUE_WATCH_MS = 60 * 1000;

/**
 * The hook reports a dialog a moment before Claude Code draws it, so the
 * pane is read for the question only after this long.
 */
const DIALOG_DRAW_MS = 500;

/** The question the session's dialog shows, when one can be read off the pane. */
async function dialogQuestion(session: Session): Promise<string | null> {
  if (!session.tmux_target) return null;
  await new Promise((resolve) => setTimeout(resolve, DIALOG_DRAW_MS));
  const content = await capturePaneContentAsync(session.tmux_target).catch(() => null);
  return content ? (readPromptOptions(content)?.question ?? null) : null;
}

/**
 * Watch the session files for as long as the server runs, whether or not any
 * page is open, and push each event to the devices that want it. Returns the
 * function that stops watching.
 */
export function startPushMonitor(send: PushSend): () => void {
  let seen = new Map<string, SeenSession>();
  let issuesWatchedAt = 0;

  // A push names a maestro worker by its issue, which the GitHub cache only
  // knows while someone asks; the session poll does only while a page is
  // open, so with every tab closed this keeps it from going stale.
  const keepIssuesWarm = (): void => {
    if (Date.now() - issuesWatchedAt < ISSUE_WATCH_MS) return;
    issuesWatchedAt = Date.now();
    watchSessionRepos(getAllSessions());
  };

  // The watcher names the sessions whose files changed, so only those are read.
  const check = (changed?: ReadonlySet<string>): void => {
    const sessions = changed
      ? [...changed].map(getSession).filter((s): s is Session => s !== null)
      : getAllSessions();
    const out = detectNotifications(seen, sessions);
    if (changed) {
      for (const id of changed) seen.delete(id);
      for (const [id, s] of out.seen) seen.set(id, s);
    } else {
      seen = out.seen;
    }
    keepIssuesWarm();
    if (out.events.length === 0) return;
    const subscriptions = getPushSubscriptions();
    for (const { session, kind } of out.events) {
      // Nobody wants it: skip reading the pane for a message no one gets.
      if (!subscriptions.some((s) => wantsEvent(s.events, kind))) continue;
      void (async () => {
        const question = kind === "completion" ? null : await dialogQuestion(session);
        await deliverPush(pushMessageFor(session, kind, question), send, subscriptions);
      })().catch((err) => console.warn("[push] Delivery failed", String(err)));
    }
  };

  check();
  return sessionWatcher.subscribe(check);
}
