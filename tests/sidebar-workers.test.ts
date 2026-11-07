import { describe, expect, it } from "vitest";
import { crewView, nestWorkers, type WorkerRow } from "../src/sidebar-workers.js";

interface S {
  id: string;
  tmux_target: string;
  maestro_role?: string | null;
  maestro_issue?: number | null;
  state?: string;
}

const session = (id: string, target: string, issue?: number): S => ({
  id,
  tmux_target: target,
  ...(issue === undefined ? {} : { maestro_role: "worker", maestro_issue: issue }),
});
const row = (s: S, orchestrator = false): WorkerRow<S> => ({ session: s, orchestrator });
const shape = (rows: WorkerRow<S>[]) =>
  rows.map((r) => ({
    id: r.session.id,
    worker: r.worker ?? false,
    workers: r.workers,
    trailing: r.trailing?.id,
    crew: r.crew ?? false,
  }));

describe("nestWorkers", () => {
  it("leaves rows without workers as they are", () => {
    const rows = [row(session("a", "main:1.0")), row(session("b", "dev:1.0"))];
    expect(nestWorkers(rows)).toBe(rows);
  });

  it("nests a daemon's worker under the session that runs the daemon", () => {
    const rows = [
      row(session("w2", "proj:3.0", 12)),
      row(session("other", "main:1.0")),
      row(session("master", "proj:1.0")),
      row(session("w1", "proj:2.0", 7)),
    ];
    expect(shape(nestWorkers(rows))).toEqual([
      { id: "other", worker: false, workers: undefined, trailing: undefined, crew: false },
      { id: "master", worker: false, workers: 2, trailing: undefined, crew: false },
      { id: "w1", worker: true, workers: undefined, trailing: undefined, crew: false },
      { id: "w2", worker: true, workers: undefined, trailing: "master", crew: false },
    ]);
  });

  it("marks a queue worker, which has no master, as a worker", () => {
    const rows = [
      row(session("w", "queue-claude-mux:1.0", 221)),
      row(session("plain", "main:1.0")),
    ];
    expect(shape(nestWorkers(rows))).toEqual([
      { id: "plain", worker: false, workers: undefined, trailing: undefined, crew: false },
      { id: "w", worker: true, workers: undefined, trailing: undefined, crew: true },
    ]);
  });

  it("gathers several queue workers of one project at the end, by issue", () => {
    const rows = [
      row(session("q30", "queue-app:3.0", 30)),
      row(session("plain", "main:1.0")),
      row(session("q10", "queue-app:1.0", 10)),
      row(session("q20", "queue-app:2.0", 20)),
    ];
    const out = nestWorkers(rows);
    expect(out.map((r) => r.session.id)).toEqual(["plain", "q10", "q20", "q30"]);
    expect(out.slice(1).every((r) => r.worker && r.crew)).toBe(true);
  });

  it("keeps daemon and queue workers apart when both run in one project", () => {
    const rows = [
      row(session("master", "proj:1.0")),
      row(session("d1", "proj:2.0", 5)),
      row(session("q1", "queue-proj:1.0", 6)),
    ];
    expect(shape(nestWorkers(rows))).toEqual([
      { id: "master", worker: false, workers: 1, trailing: undefined, crew: false },
      { id: "d1", worker: true, workers: undefined, trailing: "master", crew: false },
      { id: "q1", worker: true, workers: undefined, trailing: undefined, crew: true },
    ]);
  });

  it("never finds a master in the queue's own tmux session", () => {
    const rows = [row(session("someone", "queue-app:9.0")), row(session("q", "queue-app:1.0", 3))];
    expect(shape(nestWorkers(rows))).toEqual([
      { id: "someone", worker: false, workers: undefined, trailing: undefined, crew: false },
      { id: "q", worker: true, workers: undefined, trailing: undefined, crew: true },
    ]);
  });

  it("does not take an orchestrator for a master", () => {
    const rows = [
      row(session("orch", "queue-app:0.1"), true),
      row(session("q", "queue-app:1.0", 3)),
    ];
    expect(shape(nestWorkers(rows))).toEqual([
      { id: "orch", worker: false, workers: undefined, trailing: undefined, crew: false },
      { id: "q", worker: true, workers: undefined, trailing: undefined, crew: true },
    ]);
  });
});

describe("crewView", () => {
  const crew = [
    row({ ...session("a", "queue-app:1.0", 1), state: "busy" }),
    row({ ...session("b", "queue-app:2.0", 2), state: "busy" }),
    row({ ...session("c", "queue-app:3.0", 3), state: "waiting" }),
    row({ ...session("d", "queue-app:4.0", 4), state: "idle" }),
  ];
  const wants = (r: WorkerRow<S>) => r.session.state === "waiting";
  const pinned = (r: WorkerRow<S>) => wants(r) || r.session.id === "d";

  it("shows every worker, and says nothing, while open", () => {
    expect(crewView(crew, false, wants, pinned)).toEqual({ shown: crew, summary: "" });
  });

  it("keeps the pinned workers and sums up the group while folded", () => {
    const { shown, summary } = crewView(crew, true, wants, pinned);
    expect(shown.map((r) => r.session.id)).toEqual(["c", "d"]);
    expect(summary).toBe("2 working · 1 wants you");
  });
});
