import { existsSync } from 'fs';
import { getAllSessions, isSessionDead, type Session } from '$shared/db/sessions-json.js';
import { eventPoller, projectsHere } from '$shared/server/github-events.js';
import { loadRateTable } from '$shared/usage/rate-table.js';
import { SpendMeter } from '$shared/usage/session-spend.js';
import { resolveTranscriptPath } from '$shared/transcript/tailer.js';
import {
	WorkerQueue,
	fileHistoryStore,
	fileQueueStore,
	measureTrees,
	readMemory,
	realGit,
	realGithub,
	realTmux,
	checkoutProblem,
	countsAgainstLimit,
	type LiveWorker
} from '$shared/server/worker-queue.js';
import { EXCLUSIVE_KEY, exclusiveList, nameList, placeName, placementKey } from '$shared/worker-placement.js';
import { machineOn } from '$shared/server/machine-switch.js';
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

const spendMeter = new SpendMeter(async () => (await loadRateTable()).table);
/**
 * Each worker session's transcript once found. Until its file exists only the
 * path the hooks recorded is tried, since the fallback scans every project
 * directory and this runs on every pass.
 */
const transcripts = new Map<string, string>();

function transcriptOf(s: Session): string | null {
	const known = transcripts.get(s.id);
	if (known) return known;
	if (s.transcript_path && !existsSync(s.transcript_path)) return null;
	const found = s.cwd ? resolveTranscriptPath(s, s.id) : (s.transcript_path ?? null);
	if (found) transcripts.set(s.id, found);
	return found;
}

function liveWorkers(): LiveWorker[] {
	const live = getAllSessions()
		.filter((s) => countsAgainstLimit(s) && !isSessionDead(s))
		.map((s) => ({
			issue: s.maestro_issue ?? null,
			cwd: s.cwd ?? null,
			id: s.id,
			pid: s.pid,
			transcript: transcriptOf(s)
		}));
	spendMeter.keepOnly(live.flatMap((s) => (s.transcript ? [s.transcript] : [])));
	for (const id of transcripts.keys()) if (!live.some((s) => s.id === id)) transcripts.delete(id);
	return live;
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

/**
 * Whether the machine with this id is gone. The fleet state starts with every
 * peer offline, so a peer heard from in the last `GONE_AFTER_MS` still counts
 * as there: right after a restart its claims must stand.
 */
const GONE_AFTER_MS = 10 * 60_000;
function machineGone(id: string): boolean {
	const m = ensureFleetState().machine(id);
	if (!m) return true;
	return !m.online && Date.now() - (m.lastSeen ?? 0) > GONE_AFTER_MS;
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
		on: machineOn,
		machine: selfName,
		machineId: MACHINE_ID,
		ready: () => poller.readyIssues(),
		github: realGithub,
		tmux: realTmux,
		git: realGit,
		memory: readMemory,
		measure: measureTrees,
		spend: (transcript) => spendMeter.spend(transcript),
		history: fileHistoryStore(),
		liveWorkers,
		placement: (repo) => nameList(ensureFleetPrefs().all()[placementKey(repo)]?.value),
		keptBy,
		checkout: checkoutProblem,
		wanted: (repo) => projectsHere().get(repo)?.events['issue-ready'] === 'session',
		machineGone,
		workerCommand: workerCommandOverride()
	});
	g.__claudeMuxWorkerQueue = queue;
	poller.onSweep(() => void queue.tick());
	return queue;
}
