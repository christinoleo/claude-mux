import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { getSavedProjects } from '$shared/db/projects-json.js';
import { projectReports } from '$shared/server/project-icons.js';
import { isRepoSlug } from '$shared/github-ref.js';
import {
	eventProjectRows,
	isEventAction,
	isEventKind,
	updateProjectEvents,
	type EventAction,
	type EventKind
} from '$shared/db/event-map-json.js';
import { runningEventPoller } from '$shared/server/github-events.js';

/**
 * The state map of this machine (`src/db/event-map-json.ts`): its GitHub
 * projects, which are on and what each event does, with what the poller has
 * seen and spent. `polling` is false on a server that does not read GitHub
 * (a dev server not told to), where a change is kept but nothing fires.
 */
/** How long a change waits for GitHub to be read before it answers. */
const READ_WAIT_MS = 5_000;

function snapshot() {
	const poller = runningEventPoller();
	return {
		projects: eventProjectRows(projectReports(getSavedProjects())),
		polling: poller !== null,
		status: poller?.status() ?? null,
		log: poller?.log() ?? []
	};
}

export const GET: RequestHandler = async () => json(snapshot());

/** `{ repo, enabled?, events? }`: turn a project on or off, or change what an event does. */
export const POST: RequestHandler = async ({ request }) => {
	// This decides what GitHub events may start: only this server's own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	let body: { repo?: unknown; enabled?: unknown; events?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const repo = typeof body.repo === 'string' ? body.repo.toLowerCase() : null;
	if (!repo || !isRepoSlug(repo)) return json({ error: 'repo must be owner/name' }, { status: 400 });
	const row = eventProjectRows(projectReports(getSavedProjects())).find((p) => p.repo === repo);
	if (!row) return json({ error: 'This machine holds no checkout of that repo' }, { status: 404 });

	const events: Partial<Record<EventKind, EventAction>> = {};
	if (body.events !== undefined) {
		if (!body.events || typeof body.events !== 'object') return json({ error: 'events must be an object' }, { status: 400 });
		for (const [kind, action] of Object.entries(body.events as Record<string, unknown>)) {
			if (!isEventKind(kind) || !isEventAction(action)) {
				return json({ error: `Unknown event or action: ${kind}` }, { status: 400 });
			}
			// A push has no session to start yet; an issue's goes to the worker queue.
			if (action === 'session' && kind !== 'issue-ready') {
				return json({ error: 'Only an issue marked ready can start a session' }, { status: 409 });
			}
			events[kind] = action;
		}
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		return json({ error: 'enabled must be true or false' }, { status: 400 });
	}

	try {
		updateProjectEvents(repo, { enabled: body.enabled as boolean | undefined, root: row.root, events });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
	// The change is read at once, but the answer waits for it only a few
	// seconds: Bun drops a request that stays silent for ten.
	const poller = runningEventPoller();
	if (poller) await Promise.race([poller.poll(), new Promise((r) => setTimeout(r, READ_WAIT_MS))]);
	return json({ ok: true, ...snapshot() });
};
