/**
 * What the Workers panel (#201) draws, worked out from each machine's queue
 * status and history. Pure, so the page only lays it out.
 */

import type { QueueStatus, RunResult, WaitingIssue, WaitKind, WorkerRun } from '$shared/server/worker-queue.js';


/** How a worker or queued issue is keyed across the panel: `owner/name#n`. */
export const issueKey = (i: { repo: string; number: number }) => `${i.repo}#${i.number}`;

/** How a machine's memory is shared out, in GiB, for its strip. */
export interface MemorySplit {
	total: number;
	/** Everything but the workers: other sessions, apps, the system. */
	other: number;
	workers: { key: string; gib: number }[];
	free: number;
}

/**
 * The strip's parts. Workers are what their trees measured; what MemTotal
 * less MemAvailable leaves beyond them is "other". Null when the machine
 * cannot say how much memory it has.
 */
export function memorySplit(status: QueueStatus): MemorySplit | null {
	const total = status.memory.totalGiB ?? null;
	const free = status.memory.availableGiB;
	if (total === null || free === null || total <= 0) return null;
	const workers = [
		...status.workers.map((w) => ({ key: issueKey(w), gib: w.memGiB ?? 0 })),
		...status.others.map((o, i) => ({ key: `other:${o.sessionId ?? i}`, gib: o.memGiB ?? 0 }))
	];
	const inWorkers = workers.reduce((a, w) => a + w.gib, 0);
	return { total, other: Math.max(0, total - free - inWorkers), workers, free: Math.max(0, free) };
}

/** Whether the machine's switch is on; an older machine sends no `on`, only its queue's own `enabled`. */
export function machineIsOn(status: QueueStatus): boolean {
	const sent = status as { on?: boolean; settings: { enabled?: boolean } };
	return sent.on ?? sent.settings.enabled === true;
}

/** What the machine's line under its name says, and whether it is a hold. */
export function machineSay(status: QueueStatus): { text: string; held: boolean } {
	const { settings, running, memory } = status;
	const free = memory.availableGiB;
	const freeText =
		free !== null ? `${free.toFixed(1)} GiB free${memory.totalGiB ? ` of ${Math.round(memory.totalGiB)}` : ''}` : 'free memory unknown';
	if (!machineIsOn(status)) return { text: `Off: nothing new starts. ${running} still running`, held: true };
	if (running > settings.limit) {
		return {
			text: `${running} running over a limit of ${settings.limit}. None is stopped; nothing new starts until ${running - settings.limit} finish`,
			held: true
		};
	}
	const waiting = status.waiting.filter((w) => w.kind === 'memory').length;
	if (waiting > 0 && running < settings.limit) {
		return { text: `Has slots, but memory is holding ${waiting} back: ${freeText}`, held: true };
	}
	return { text: `${running} of ${settings.limit} running, ${freeText}`, held: false };
}

/** A queued issue across the fleet: every machine sees the same queue, so each issue once, with the reason that says most. */
export interface QueuedIssue extends WaitingIssue {
	machine: string;
}

/** Which reason wins when machines disagree: a machine that may run the issue says more than one that may not. */
const SAYS_MOST: WaitKind[] = ['blocked', 'running', 'closed', 'taken', 'memory', 'slot', 'github', 'off', 'placed'];

export function mergeQueues(byMachine: { machine: string; waiting: WaitingIssue[] }[]): QueuedIssue[] {
	const out = new Map<string, QueuedIssue>();
	for (const { machine, waiting } of byMachine) {
		for (const w of waiting) {
			const key = issueKey(w);
			const have = out.get(key);
			const since = have?.since != null && w.since != null ? Math.min(have.since, w.since) : (have?.since ?? w.since);
			if (!have || SAYS_MOST.indexOf(w.kind) < SAYS_MOST.indexOf(have.kind)) out.set(key, { ...w, machine, since });
			else have.since = since;
		}
	}
	// A worker owns it or asked for help (it is running somewhere), or it just closed: not queued.
	return [...out.values()].filter((q) => q.kind !== 'running' && q.kind !== 'closed');
}

export const RESULTS: { result: RunResult; label: string; mark: string }[] = [
	{ result: 'merged', label: 'Merged', mark: '✓' },
	{ result: 'help', label: 'Asked for help', mark: '?' },
	{ result: 'lost', label: 'Lost', mark: '✕' },
	{ result: 'stopped', label: 'Stopped by hand', mark: '■' },
	{ result: 'closed', label: 'Closed unplanned', mark: '–' }
];

export interface HistoryDay {
	/** Midnight, local, in ms. */
	start: number;
	counts: Record<RunResult, number>;
	/** The median wait from ready to started, in minutes, of the runs started that day; null for none. */
	medianWait: number | null;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const v = [...values].sort((a, b) => a - b);
	const mid = Math.floor(v.length / 2);
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

const empty = (): Record<RunResult, number> => ({ merged: 0, help: 0, lost: 0, stopped: 0, closed: 0 });

/** One bucket per day of the last `days`, today last: runs by the day they ended, waits by the day they started. */
export function historyDays(runs: readonly WorkerRun[], days: number, now: number): HistoryDay[] {
	const today = startOfDay(now);
	const out: HistoryDay[] = [];
	for (let i = days - 1; i >= 0; i--) {
		// Through Date, not 86.4M ms at a time, so a daylight-saving change does not shift a day.
		const d = new Date(today);
		d.setDate(d.getDate() - i);
		out.push({ start: d.getTime(), counts: empty(), medianWait: null });
	}
	const index = (ms: number) => {
		const start = startOfDay(ms);
		return out.findIndex((d) => d.start === start);
	};
	const waits = out.map(() => [] as number[]);
	for (const r of runs) {
		const e = index(r.endedAt);
		if (e >= 0) out[e].counts[r.result]++;
		const s = index(r.startedAt);
		if (s >= 0 && r.queuedAt !== null) waits[s].push(Math.max(0, (r.startedAt - r.queuedAt) / 60_000));
	}
	out.forEach((d, i) => (d.medianWait = median(waits[i])));
	return out;
}

export interface HistoryTiles {
	finished: number;
	/** Share merged on their own, 0–100; null with none finished. */
	mergedPct: number | null;
	/** Median run, in minutes. */
	medianRun: number | null;
	peakGiB: number | null;
	spendUsd: number;
}

export function historyTiles(runs: readonly WorkerRun[]): HistoryTiles {
	const peaks = runs.map((r) => r.peakGiB).filter((p): p is number => p !== null);
	return {
		finished: runs.length,
		mergedPct: runs.length ? Math.round((runs.filter((r) => r.result === 'merged').length / runs.length) * 100) : null,
		medianRun: median(runs.map((r) => (r.endedAt - r.startedAt) / 60_000)),
		peakGiB: peaks.length ? Math.max(...peaks) : null,
		spendUsd: runs.reduce((a, r) => a + (r.spendUsd ?? 0), 0)
	};
}

/** The runs that ended within the last `days` days. */
export function within(runs: readonly WorkerRun[], days: number, now: number): WorkerRun[] {
	// By calendar date, as the day buckets are, so a daylight-saving change moves nothing.
	const start = new Date(startOfDay(now));
	start.setDate(start.getDate() - (days - 1));
	const since = start.getTime();
	return runs.filter((r) => r.endedAt >= since);
}

/** "42m", "1h 7m". */
export function minutes(m: number | null): string {
	if (m === null) return '–';
	const r = Math.round(m);
	return r >= 60 ? `${Math.floor(r / 60)}h ${r % 60}m` : `${r}m`;
}
