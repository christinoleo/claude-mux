import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { getSavedProjects } from '$shared/db/projects-json.js';
import { projectReports } from '$shared/server/project-icons.js';
import { eventProjectRows } from '$shared/db/event-map-json.js';
import { runningEventPoller } from '$shared/server/github-events.js';
import { clockTriggerView, eventTriggers, parseTriggerInput } from '$shared/server/triggers.js';
import { workerQueue } from '$lib/server/worker-queue.js';
import { scheduler } from '$lib/server/triggers.js';

/**
 * This machine's Triggers (`src/server/triggers.ts`): its clock Triggers with
 * their Runs, and the event Triggers the state map makes, with what the poller
 * and the worker queue did. `projects` are the GitHub projects it holds, for
 * the form. `running` is false on a server that does not run the scheduler (a
 * dev server not told to), where nothing fires.
 */
function snapshot() {
	const s = scheduler();
	const projects = eventProjectRows(projectReports(getSavedProjects()));
	const clock = s?.triggers().map((t) => clockTriggerView(t, s.runs(t.id))) ?? [];
	const events = eventTriggers({
		projects,
		seen: runningEventPoller()?.log() ?? [],
		queue: workerQueue()?.status().log ?? []
	});
	return {
		running: s !== null,
		now: Date.now(),
		triggers: [...clock, ...events],
		projects: projects.map((p) => ({ repo: p.repo, root: p.root }))
	};
}

export const GET: RequestHandler = async () => json(snapshot());

/** A new clock Trigger, as the form sends it. */
export const POST: RequestHandler = async ({ request }) => {
	// A Trigger can start sessions on this machine: only its own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const s = scheduler();
	if (!s) return json({ error: 'This server runs no scheduler, so nothing would fire' }, { status: 409 });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const input = parseTriggerInput(body);
	if (typeof input === 'string') return json({ error: input }, { status: 400 });
	// A session runs in a checkout this machine holds, never a path the request makes up.
	if (input.root && !snapshot().projects.some((p) => p.root === input.root)) {
		return json({ error: 'That project is not one this machine holds' }, { status: 400 });
	}
	s.create(input);
	return json(snapshot());
};
