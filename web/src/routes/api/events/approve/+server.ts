import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isRepoSlug } from '$shared/db/event-map-json.js';
import { runningEventPoller } from '$shared/server/github-events.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/**
 * `{ repo, number }`: Leo approves an issue someone else touched after he
 * marked it ready. The label goes back on under his name, through this
 * machine's `gh`, and GitHub is read again.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: { repo?: unknown; number?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const repo = typeof body.repo === 'string' ? body.repo.toLowerCase() : null;
	const number = body.number;
	if (!isRepoSlug(repo) || typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
		return json({ error: 'repo must be owner/name and number an issue number' }, { status: 400 });
	}
	const poller = runningEventPoller();
	if (!poller) return json({ error: 'This server does not read GitHub' }, { status: 409 });
	const ok = await poller.approve(repo, number);
	if (!ok) return json({ error: 'Nothing waits for approval there, or GitHub refused the label' }, { status: 409 });
	broadcastSessions();
	return json({ ok: true });
};
