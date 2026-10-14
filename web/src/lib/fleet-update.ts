/**
 * Updating machines from the Machines view: one at a time, the origin last.
 *
 * Each machine runs its own `claude-mux update` (`POST <base>/api/update`,
 * `src/server/self-update.ts`) and is then read until the job it started says
 * how it ended. The update restarts that machine's server, so a read that
 * finds nobody answering means it is coming back, not that it failed. The
 * origin goes last because its restart takes this page's server with it.
 * Nothing here touches the DOM; the requests and the clock are handed in.
 */

export type StepState = 'queued' | 'starting' | 'running' | 'restarting' | 'ok' | 'failed';

export interface StepProgress {
	state: StepState;
	/** One line saying where it is: the update's last line, or why it failed. */
	line: string;
	/** What the update printed, as far as the machine has said. */
	output: string;
	/** The version the machine answered with at the end. */
	version: string | null;
}

/** An answer from a machine: its status and JSON body, or null when it did not answer. */
export type Answer = { status: number; body: Record<string, unknown> } | null;

export interface UpdateIO {
	request(url: string, method: 'GET' | 'POST'): Promise<Answer>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

export interface UpdateTiming {
	pollMs: number;
	/** How long a machine has from the start to report a result. */
	timeoutMs: number;
}

/** How long a machine that finished its update may keep answering with the old version. */
const RESTART_GRACE_MS = 30_000;
/** What `claude-mux update` prints when it installs nothing and restarts nothing. */
const NOTHING_TO_DO = /Already on latest|skipping restart/;

export const DEFAULT_TIMING: UpdateTiming = { pollMs: 1_500, timeoutMs: 10 * 60_000 };

/** The machines in the order they are updated: as given, with the origin moved last. */
export function updateOrder<T extends { origin: boolean }>(machines: readonly T[]): T[] {
	return [...machines.filter((m) => !m.origin), ...machines.filter((m) => m.origin)];
}

/** The last line of an update's output that says anything. */
export function lastLine(output: string): string {
	const lines = output.split('\n').map((l) => l.trim());
	return lines.filter(Boolean).at(-1) ?? '';
}

interface JobAnswer {
	fromVersion?: unknown;
	state?: unknown;
	startedAt?: unknown;
	output?: unknown;
	exitCode?: unknown;
}

function jobOf(body: Record<string, unknown>): JobAnswer | null {
	const job = body.job;
	return job && typeof job === 'object' ? (job as JobAnswer) : null;
}

/**
 * Update the machine whose API is at `base` ('' for the origin, `/fleet/<id>`
 * for another) and resolve with how it ended. Never rejects.
 */
export async function updateMachine(
	base: string,
	onProgress: (p: StepProgress) => void,
	io: UpdateIO,
	timing: UpdateTiming = DEFAULT_TIMING
): Promise<StepProgress> {
	const url = `${base}/api/update`;
	const report = (p: StepProgress) => {
		onProgress(p);
		return p;
	};
	const fail = (line: string, output = '') => report({ state: 'failed', line, output, version: null });
	const ask = (method: 'GET' | 'POST') => io.request(url, method).catch((): Answer => null);

	report({ state: 'starting', line: 'Starting the update…', output: '', version: null });
	const started = await ask('POST');
	if (!started) return fail('Did not answer');
	// The relay's own 404 (a machine it does not know) carries an `error`; a machine without the route does not.
	if (started.status === 404 && typeof started.body.error !== 'string') {
		return fail('Too old to be updated from here; run `claude-mux update` on it');
	}
	const startJob = jobOf(started.body);
	if ((started.status !== 202 && started.status !== 409) || typeof startJob?.startedAt !== 'number') {
		return fail(typeof started.body.error === 'string' ? started.body.error : `Refused (${started.status})`);
	}
	const startedAt = startJob.startedAt;
	const deadline = io.now() + timing.timeoutMs;
	let output = '';
	let restartWait: number | undefined;

	while (io.now() < deadline) {
		await io.sleep(timing.pollMs);
		const answer = await ask('GET');
		// Nobody answering, or the relay's 502 for a machine it cannot reach: a restart in progress.
		if (!answer || answer.status >= 500) {
			report({ state: 'restarting', line: 'Restarting…', output, version: null });
			continue;
		}
		const job = jobOf(answer.body);
		if (!job || job.startedAt !== startedAt) {
			report({ state: 'restarting', line: 'Waiting for it to report…', output, version: null });
			continue;
		}
		output = typeof job.output === 'string' ? job.output : output;
		const version = typeof answer.body.version === 'string' ? answer.body.version : null;
		if (job.state === 'running') {
			report({ state: 'running', line: lastLine(output) || 'Updating…', output, version: null });
			continue;
		}
		if (job.state === 'ok') {
			// The update exits as soon as it has asked for the restart, so the old
			// server may still be the one answering; it is given a while to go.
			const stale = version !== null && version === job.fromVersion && !NOTHING_TO_DO.test(output);
			if (stale && (restartWait ??= io.now() + RESTART_GRACE_MS) > io.now()) {
				report({ state: 'restarting', line: 'Restarting…', output, version: null });
				continue;
			}
			return report({ state: 'ok', line: lastLine(output) || 'Updated', output, version });
		}
		const code = typeof job.exitCode === 'number' ? ` (exit ${job.exitCode})` : '';
		return fail(`${lastLine(output) || 'Update failed'}${code}`, output);
	}
	return fail(`No result after ${Math.round(timing.timeoutMs / 60_000)} min`, output);
}

/**
 * Update every machine in turn, origin last, carrying on past a failure.
 * `run` updates one machine and reports its progress under its id; the
 * results come back in the order the machines were updated.
 */
export async function updateAll<T extends { id: string; origin: boolean }>(
	machines: readonly T[],
	run: (machine: T) => Promise<StepProgress>
): Promise<{ machine: T; result: StepProgress }[]> {
	const results: { machine: T; result: StepProgress }[] = [];
	for (const machine of updateOrder(machines)) {
		let result: StepProgress;
		try {
			result = await run(machine);
		} catch (err) {
			result = { state: 'failed', line: String(err), output: '', version: null };
		}
		results.push({ machine, result });
	}
	return results;
}

/** The browser's way of asking a machine: `fetch`, with anything but a JSON answer counted as no answer. */
export const browserIO: UpdateIO = {
	async request(url, method) {
		try {
			const res = await fetch(url, { method, cache: 'no-store' });
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			return { status: res.status, body };
		} catch {
			return null;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	now: () => Date.now()
};
