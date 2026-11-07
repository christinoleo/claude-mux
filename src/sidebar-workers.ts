/**
 * Where a maestro worker sits in the sidebar. A worker is a session whose
 * hook recorded `maestro_role: 'worker'`, whoever started it.
 *
 * The per-repo daemon opens each worker as a window of the tmux session its
 * master runs in, so a worker's master is the one non-worker session there,
 * and the worker is drawn under it. The worker queue (`queue-<repo>`) and a
 * daemon that has gone leave workers with no master: those are drawn
 * together after the place's other sessions, under a header of their own.
 */

export interface WorkerSession {
  maestro_role?: string | null;
  maestro_issue?: number | null;
  tmux_target?: string | null;
  state?: string | null;
}

export interface WorkerRow<S extends WorkerSession = WorkerSession> {
  session: S;
  orchestrator: boolean;
  /** A maestro worker, drawn on a worker's thread. */
  worker?: boolean;
  /** On a master's row: how many workers sit under it. */
  workers?: number;
  /** On the last of a master's workers: the master, whose own subagents follow the workers. */
  trailing?: S;
  /** A worker with no master, one of the group drawn together at the end of its place. */
  crew?: boolean;
}

/** A group bigger than this starts folded, so a busy queue does not flood the list. */
export const CREW_FOLD_ABOVE = 3;

export function isWorker(s: WorkerSession): boolean {
  return s.maestro_role === "worker";
}

const isWorkerRow = (r: WorkerRow) => !r.orchestrator && isWorker(r.session);

/** The worker queue's tmux sessions (`queueSessionName()`) hold only workers, so nothing there is a master. */
const QUEUE_SESSION = /^queue-/;

/** The tmux session a pane belongs to: `main` of `main:2.0`. */
function tmuxSessionOf(s: WorkerSession): string | null {
  return s.tmux_target?.split(":")[0] ?? null;
}

const byIssue = (a: WorkerRow, b: WorkerRow) =>
  (a.session.maestro_issue ?? 0) - (b.session.maestro_issue ?? 0);

/** Lays out one place's rows: each worker under its master, masterless workers grouped at the end. */
export function nestWorkers<S extends WorkerSession, R extends WorkerRow<S>>(rows: R[]): R[] {
  if (!rows.some(isWorkerRow)) return rows;

  const masterIn = new Map<string, R>();
  for (const r of rows) {
    const home = tmuxSessionOf(r.session);
    if (home && !QUEUE_SESSION.test(home) && !r.orchestrator && !isWorker(r.session) && !masterIn.has(home))
      masterIn.set(home, r);
  }
  const workersOf = new Map<R, R[]>();
  const loose: R[] = [];
  for (const row of rows) {
    if (!isWorkerRow(row)) continue;
    const home = tmuxSessionOf(row.session);
    const master = home ? masterIn.get(home) : undefined;
    if (!master) loose.push(row);
    else if (workersOf.has(master)) workersOf.get(master)!.push(row);
    else workersOf.set(master, [row]);
  }

  const out: R[] = [];
  for (const row of rows) {
    if (isWorkerRow(row)) continue;
    const workers = workersOf.get(row);
    if (!workers) {
      out.push(row);
      continue;
    }
    out.push({ ...row, workers: workers.length });
    out.push(...workers.sort(byIssue).map((w) => ({ ...w, worker: true })));
    out.at(-1)!.trailing = row.session;
  }
  out.push(...loose.sort(byIssue).map((w) => ({ ...w, worker: true, crew: true })));
  return out;
}

/**
 * What a group of masterless workers draws. Folded, it keeps the rows a
 * person should still see (`pinned`: one that wants them, the one on screen)
 * and says the rest in a line: "2 working · 1 wants you".
 */
export function crewView<R extends WorkerRow>(
  crew: R[],
  folded: boolean,
  wants: (r: R) => boolean,
  pinned: (r: R) => boolean
): { shown: R[]; summary: string } {
  if (!folded) return { shown: crew, summary: "" };
  const nWants = crew.filter(wants).length;
  const busy = crew.filter((r) => r.session.state === "busy").length;
  const summary = [
    busy ? `${busy} working` : null,
    nWants ? `${nWants} ${nWants === 1 ? "wants" : "want"} you` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { shown: crew.filter(pinned), summary };
}
