import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSavedProjects } from '$shared/db/projects-json.js';
import { projectReports } from '$shared/server/project-icons.js';
import {
	EVENT_KINDS,
	eventProjectRows,
	isEventAction,
	isRepoSlug,
	updateProjectEvents,
	type EventAction,
	type EventKind
} from '$shared/db/event-map-json.js';
import { runningEventPoller } from '$shared/server/github-events.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/**
 * The state map of this machine (`src/db/event-map-json.ts`): its GitHub
 * projects, which are on and what each event does, with what the poller has
 * seen and spent. `polling` is false on a server that does not read GitHub
 * (a dev server not told to), where a change is kept but nothing fires.
 */
export const GET: RequestHandler = async () => {
	const poller = runningEventPoller();
	return json({
		projects: eventProjectRows(projectReports(getSavedProjects())),
		polling: poller !== null,
		status: poller?.status() ?? null,
		log: poller?.log() ?? []
	});
};

/** `{ repo, enabled?, events? }`: turn a project on or off, or change what an event does. */
export const POST: RequestHandler = async ({ request }) => {
	let body: { repo?: unknown; enabled?: unknown; events?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const repo = typeof body.repo === 'string' ? body.repo.toLowerCase() : null;
	if (!isRepoSlug(repo)) return json({ error: 'repo must be owner/name' }, { status: 400 });
	const row = eventProjectRows(projectReports(getSavedProjects())).find((p) => p.repo === repo);
	if (!row) return json({ error: 'This machine holds no checkout of that repo' }, { status: 404 });

	const events: Partial<Record<EventKind, EventAction>> = {};
	if (body.events !== undefined) {
		if (!body.events || typeof body.events !== 'object') return json({ error: 'events must be an object' }, { status: 400 });
		for (const [kind, action] of Object.entries(body.events as Record<string, unknown>)) {
			if (!(EVENT_KINDS as readonly string[]).includes(kind) || !isEventAction(action)) {
				return json({ error: `Unknown event or action: ${kind}` }, { status: 400 });
			}
			// Sessions come with the worker queue; until then nothing may ask for one.
			if (action === 'session') return json({ error: 'Starting a session is not available yet' }, { status: 409 });
			events[kind as EventKind] = action;
		}
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		return json({ error: 'enabled must be true or false' }, { status: 400 });
	}

	updateProjectEvents(repo, { enabled: body.enabled as boolean | undefined, root: row.root, events });
	const poller = runningEventPoller();
	if (poller) {
		await poller.poll();
		broadcastSessions();
	}
	return json({
		ok: true,
		projects: eventProjectRows(projectReports(getSavedProjects())),
		polling: poller !== null,
		status: poller?.status() ?? null,
		log: poller?.log() ?? []
	});
};
