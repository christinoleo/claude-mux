import { describe, it, expect } from "vitest";
import { historyDays, historyTiles, machineSay, memorySplit, mergeQueues, minutes, within } from "$lib/workers";
import { DEFAULT_SETTINGS, type QueueStatus, type WaitingIssue, type WorkerRun } from "../../src/server/worker-queue.js";

function status(extra: Partial<QueueStatus> = {}): QueueStatus {
  return {
    machine: "omarchy",
    on: true,
    settings: { ...DEFAULT_SETTINGS },
    running: 0,
    memory: { totalGiB: 16, availableGiB: 8, pressure: 0 },
    hold: null,
    workers: [],
    others: [],
    waiting: [],
    log: [],
    lastTickAt: null,
    lastError: null,
    ...extra,
  };
}

const T = new Date(2026, 10, 7, 15, 0).getTime();
function run(extra: Partial<WorkerRun>): WorkerRun {
  return {
    repo: "o/r",
    number: 1,
    title: "t",
    url: "u",
    machine: "omarchy",
    queuedAt: T - 50 * 60_000,
    startedAt: T - 40 * 60_000,
    endedAt: T,
    result: "merged",
    peakGiB: 1.5,
    spendUsd: 2,
    ...extra,
  };
}

function waiting(number: number, kind: WaitingIssue["kind"], why: string, since: number | null = null): WaitingIssue {
  return { repo: "o/r", number, title: `#${number}`, url: "", why, kind, since };
}

describe("the Workers panel's numbers", () => {
  it("splits a machine's memory into other, its workers and free", () => {
    const st = status({
      workers: [{ repo: "o/r", number: 1, memGiB: 1.5 } as QueueStatus["workers"][number]],
      others: [{ issue: 9, cwd: null, sessionId: "d", memGiB: 0.5 }],
    });
    expect(memorySplit(st)).toEqual({
      total: 16,
      other: 6,
      workers: [
        { key: "o/r#1", gib: 1.5 },
        { key: "other:d", gib: 0.5 },
      ],
      free: 8,
    });
    expect(memorySplit(status({ memory: { availableGiB: 8, pressure: 0 } }))).toBeNull();
  });

  it("says when a machine is off, over its limit, or held by memory", () => {
    expect(machineSay(status({ running: 2 })).text).toBe("2 of 8 running, 8.0 GiB free of 16");
    expect(machineSay(status({ on: false, running: 1 }))).toEqual({ text: "Off: nothing new starts. 1 still running", held: true });
    // An older machine sends no `on`, only its queue's own switch.
    const older = (enabled: boolean) => status({ on: undefined, settings: { ...DEFAULT_SETTINGS, enabled } as typeof DEFAULT_SETTINGS });
    expect(machineSay(older(true)).held).toBe(false);
    expect(machineSay(older(false)).held).toBe(true);
    expect(machineSay(status({ running: 9 })).text).toMatch(/over a limit of 8.*until 1 finish/);
    expect(machineSay(status({ waiting: [waiting(1, "memory", "Held")] })).text).toMatch(/memory is holding 1 back/);
  });

  it("lists each queued issue once across machines, by the reason that says most and the earliest wait", () => {
    const merged = mergeQueues([
      { machine: "engage", waiting: [waiting(1, "placed", "Placed on omarchy", 5), waiting(2, "running", "A worker owns it")] },
      { machine: "omarchy", waiting: [waiting(1, "slot", "At the limit", 9), waiting(3, "taken", "On hold")] },
    ]);
    expect(merged.map((q) => [q.number, q.kind, q.machine, q.since])).toEqual([
      [1, "slot", "omarchy", 5],
      [3, "taken", "omarchy", null],
    ]);
  });

  it("buckets runs by day and finds the median wait", () => {
    const runs = [
      run({ result: "merged" }),
      run({ result: "lost", queuedAt: T - 60 * 60_000 }),
      run({ result: "help", endedAt: T - 86_400_000, startedAt: T - 86_400_000 - 600_000, queuedAt: null }),
    ];
    const days = historyDays(runs, 7, T);
    expect(days).toHaveLength(7);
    expect(days[6].counts).toMatchObject({ merged: 1, lost: 1 });
    expect(days[6].medianWait).toBe(15);
    expect(days[5].counts.help).toBe(1);
    expect(days[5].medianWait).toBeNull();
    expect(historyTiles(runs)).toEqual({ finished: 3, mergedPct: 33, medianRun: 40, peakGiB: 1.5, spendUsd: 6 });
    expect(within(runs, 1, T)).toHaveLength(2);
    expect(minutes(67)).toBe("1h 7m");
  });
});
