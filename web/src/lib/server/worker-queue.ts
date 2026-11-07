import { getAllSessions, isSessionDead } from '$shared/db/sessions-json.js';
import { eventPoller } from '$shared/server/github-events.js';
import {
	WorkerQueue,
	fileQueueStore,
	readMemory,
	realGit,
	realGithub,
	realTmux,
	countsAgainstLimit,
	type LiveWorker
} from '$shared/server/worker-queue.js';
import { EXCLUSIVE_KEY, exclusiveList, nameList, placeName, placementKey } from '$shared/worker-placement.js';
import { MACHINE_ID } from '$lib/server/instance';
import { selfName } from '$lib/server/discover';
import { ensureFleetPrefs, ensureFleetState } from '$lib/server/fleet.js';

/**
 * This server's worker queue (`src/server/worker-queue.ts`), run after every
 * sweep of the event poller. Placement and the machines that keep their
 * projects come from the fleet preferences, and which machine holds what from
 * the fleet state, so every machine answers alike.
 */

const g = globalThis as typeof globalThis & { __claudeMuxWorkerQueue?: WorkerQueue };

function liveWorkers(): LiveWorker[] {
	return getAllSessions()
		.filter((s) => countsAgainstLimit(s) && !isSessionDead(s))
		.map((s) => ({ issue: s.maestro_issue ?? null, cwd: s.cwd ?? null }));
}

/** The name of another machine that keeps its projects and holds `repo`, or null. */
function keptBy(repo: string): string | null {
	const keepers = exclusiveList(ensureFleetPrefs().all()[EXCLUSIVE_KEY]?.value);
	const self = placeName(selfName());
	for (const m of ensureFleetState().snapshot()) {
		const name = placeName(m.hostname);
		if (name === self || !keepers.includes(name)) continue;
		if (m.projectReports.some((r) => r.sub === '' && r.remote?.toLowerCase() === `github.com/${repo.toLowerCase()}`)) return name;
	}
	return null;
}

/**
 * A command for every worker in place of `claude`, with `{issue}` for its
 * number: for a test of the queue under a HOME of its own, never set on a
 * real installation.
 */
function workerCommandOverride(): ((issue: number) => string) | undefined {
	const template = process.env.CLAUDE_MUX_WORKER_COMMAND;
	return template ? (issue) => template.replaceAll('{issue}', String(issue)) : undefined;
}

/** The queue, started with the poller; null on a server that does not poll. */
export function workerQueue(): WorkerQueue | null {
	return g.__claudeMuxWorkerQueue ?? null;
}

export function startWorkerQueue(): WorkerQueue {
	if (g.__claudeMuxWorkerQueue) return g.__claudeMuxWorkerQueue;
	const poller = eventPoller();
	const queue = new WorkerQueue({
		store: fileQueueStore(),
		machine: selfName,
		machineId: MACHINE_ID,
		ready: () => poller.readyIssues(),
		github: realGithub,
		tmux: realTmux,
		git: realGit,
		memory: readMemory,
		liveWorkers,
		placement: (repo) => nameList(ensureFleetPrefs().all()[placementKey(repo)]?.value),
		keptBy,
		workerCommand: workerCommandOverride()
	});
	g.__claudeMuxWorkerQueue = queue;
	poller.onSweep(() => void queue.tick());
	return queue;
}
