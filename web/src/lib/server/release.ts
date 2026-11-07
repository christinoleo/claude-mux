import { join } from 'node:path';
import { CLAUDE_MUX_DIR } from '$shared/utils/paths.js';
import { VERSION } from '$shared/utils/version.js';
import { enabledProjects } from '$shared/db/event-map-json.js';
import { RELEASE_REPO, eventPoller } from '$shared/server/github-events.js';
import { readUpdateJob, startUpdate } from '$shared/server/self-update.js';
import {
	RELEASE_EXCLUDE_KEY,
	RELEASE_TICK_MS,
	ReleaseRule,
	fileReleaseStore,
	gitReleaseRepo,
	realExec,
	releaseExcludeList,
	takesPart,
	type ReleaseMachine
} from '$shared/server/release.js';
import { placeName } from '$shared/worker-placement.js';
import { jsonInit, lastLine, updateMachine, type UpdateIO } from '$lib/fleet-update';
import { MACHINE_ID } from '$lib/server/instance';
import { machineUrl, selfName } from '$lib/server/discover';
import { ensureFleetPrefs, ensureFleetState } from '$lib/server/fleet.js';

/**
 * This server's release rule (`src/server/release.ts`), started beside the
 * event poller and ticked after each of its reads. It acts only while the
 * state map has claude-mux enabled here with its push event set to the rule,
 * which is how the one machine that releases is chosen.
 */

const UPDATE_DIR = join(CLAUDE_MUX_DIR, 'update');
const g = globalThis as typeof globalThis & { __claudeMuxRelease?: ReleaseRule };

const run = (cmd: string, args: string[], cwd?: string) => realExec(cmd, args, cwd, 60_000);

/** The project as the state map holds it, when its pushes are the rule's. */
function releaseProject() {
	const project = enabledProjects().get(RELEASE_REPO);
	return project && project.events.push === 'rule' ? project : null;
}

/** The machines that take part, with where each is reached: none that `release:exclude` names, nor one whose name is unknown. */
async function machines(): Promise<(ReleaseMachine & { url: string | null })[]> {
	const exclude = releaseExcludeList(ensureFleetPrefs().all()[RELEASE_EXCLUDE_KEY]?.value);
	const self = { id: MACHINE_ID, hostname: selfName(), self: true, online: true, url: await machineUrl(MACHINE_ID) };
	const others = ensureFleetState()
		.snapshot()
		.map((m) => ({ id: m.id, hostname: m.hostname, self: false, online: m.online, url: m.url }));
	return [self, ...others]
		.filter((m) => takesPart(m.hostname, exclude))
		.map(({ hostname, ...m }) => ({ ...m, name: placeName(hostname) }));
}

/** The server's way of asking a machine, the same answers the Machines view reads. */
const serverIO: UpdateIO = {
	async request(url, method, payload) {
		try {
			const res = await fetch(url, {
				method,
				signal: AbortSignal.timeout(20_000),
				...jsonInit(payload)
			});
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			return { status: res.status, body };
		} catch {
			return null;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	now: Date.now
};

async function health(url: string | null): Promise<string | null> {
	if (!url) return null;
	const answer = await serverIO.request(`${url}/api/health`, 'GET');
	if (!answer || answer.status !== 200 || answer.body.status !== 'ok') return null;
	return typeof answer.body.version === 'string' ? answer.body.version : null;
}

export function releaseRule(): ReleaseRule | null {
	return g.__claudeMuxRelease ?? null;
}

export function startReleaseRule(): ReleaseRule {
	if (g.__claudeMuxRelease) return g.__claudeMuxRelease;
	const poller = eventPoller();
	// Read once a tick: what `machines()` answered last, so the rule can ask synchronously.
	let known: Awaited<ReturnType<typeof machines>> = [];
	const urlOf = (id: string) => known.find((m) => m.id === id)?.url ?? null;
	const rule = new ReleaseRule({
		store: fileReleaseStore(join(CLAUDE_MUX_DIR, 'release.json')),
		repo: gitReleaseRepo({
			dir: join(CLAUDE_MUX_DIR, 'release'),
			// The checkout's own remote, so the push goes through whatever credentials it already uses.
			remote: async () => {
				const root = releaseProject()?.root;
				const res = root ? await run('git', ['remote', 'get-url', 'origin'], root) : null;
				return res?.ok ? res.output.trim() : `https://github.com/${RELEASE_REPO}.git`;
			}
		}),
		github: () => (releaseProject() ? poller.branch(RELEASE_REPO) : null),
		async fileIssue(title, body) {
			const res = await run('gh', ['issue', 'create', '--repo', RELEASE_REPO, '--title', title, '--body', body]);
			const n = Number(/\/issues\/(\d+)/.exec(res.output)?.[1]);
			return res.ok && n > 0 ? n : null;
		},
		async commentIssue(issue, body) {
			const state = await run('gh', ['issue', 'view', String(issue), '--repo', RELEASE_REPO, '--json', 'state', '--jq', '.state']);
			if (!state.ok || state.output.trim() !== 'OPEN') return false;
			return (await run('gh', ['issue', 'comment', String(issue), '--repo', RELEASE_REPO, '--body', body])).ok;
		},
		async published(version) {
			const res = await run('npm', ['view', `claude-mux@${version}`, 'version']);
			return res.ok && res.output.split('\n').some((line) => line.trim() === version);
		},
		machines: () => known,
		updateSelf(version) {
			const { job } = startUpdate({ dir: UPDATE_DIR, fromVersion: VERSION, target: version });
			return job.startedAt;
		},
		selfJob() {
			const job = readUpdateJob(UPDATE_DIR);
			return job ? { startedAt: job.startedAt, state: job.state, line: lastLine(job.output) } : null;
		},
		async updateRemote(machine, version) {
			const url = urlOf(machine.id);
			if (!url) return { ok: false, line: 'No address known for it' };
			const result = await updateMachine(url, () => {}, serverIO, version);
			return { ok: result.state === 'ok', line: result.line };
		},
		health: (machine) => health(urlOf(machine.id))
	});
	const tick = async () => {
		if (!releaseProject()) return;
		known = await machines();
		await rule.tick();
	};
	poller.onSweep(() => void tick());
	setInterval(() => void tick(), RELEASE_TICK_MS).unref?.();
	g.__claudeMuxRelease = rule;
	return rule;
}
