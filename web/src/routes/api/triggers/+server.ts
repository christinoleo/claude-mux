import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSavedProjects } from '$shared/db/projects-json.js';
import { projectReports } from '$shared/server/project-icons.js';
import { eventProjectRows } from '$shared/db/event-map-json.js';
import { runningEventPoller } from '$shared/server/github-events.js';
import { clockTriggerView, eventTriggers, parseTriggerInput } from '$shared/server/triggers.js';
import { workerQueue } from '$lib/server/worker-queue.js';
import { scheduler, schedulerFor } from '$lib/server/triggers.js';

/**
 * This machine's Triggers (`src/server/triggers.ts`): its clock Triggers with
 * their Runs, and the event Triggers the state map makes, with what the poller
 * and the worker queue did. `projects` are the GitHub projects it holds, for
 * the form. `running` is false on a server that does not run the scheduler (a
 * dev server not told to), where nothing fires.
 */
function snapshot(projects = eventProjectRows(projectReports(getSavedProjects()))) {
	const s = scheduler();
	const clock = s?.triggers().map((t) => clockTriggerView(t, s.runs(t.id))) ?? [];
	const events = eventTriggers({
		projects,
		seen: runningEventPoller()?.log() ?? [],
		queue: workerQueue()?.status().log ?? []
	});
	return {
		running: s !== null,
		triggers: [...clock, ...events],
		projects: projects.map((p) => ({ repo: p.repo, root: p.root }))
	};
}

export const GET: RequestHandler = async () => json(snapshot());

/** A new clock Trigger, as the form sends it. */
export const POST: RequestHandler = async ({ request }) => {
	const s = schedulerFor(request);
	if (s instanceof Response) return s;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const input = parseTriggerInput(body);
	if (typeof input === 'string') return json({ error: input }, { status: 400 });
	const projects = eventProjectRows(projectReports(getSavedProjects()));
	if (input.root) {
		// A session runs in a checkout this machine holds, never a path the request makes up.
		const project = projects.find((p) => p.root === input.root);
		if (!project) return json({ error: 'That project is not one this machine holds' }, { status: 400 });
		input.repo = project.repo;
	}
	s.create(input);
	return json(snapshot(projects));
};
