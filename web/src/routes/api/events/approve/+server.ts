import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { isRepoSlug } from '$shared/github-ref.js';
import { runningEventPoller } from '$shared/server/github-events.js';

/**
 * `{ repo, number }`: Leo approves an issue someone else touched after he
 * marked it ready. The label goes back on under his name, through this
 * machine's `gh`, and GitHub is read again.
 */
export const POST: RequestHandler = async ({ request }) => {
	// This labels issues under the gh account: only this server's own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	let body: { repo?: unknown; number?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const repo = typeof body.repo === 'string' ? body.repo.toLowerCase() : null;
	const number = body.number;
	if (!repo || !isRepoSlug(repo) || typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
		return json({ error: 'repo must be owner/name and number an issue number' }, { status: 400 });
	}
	const poller = runningEventPoller();
	if (!poller) return json({ error: 'This server does not read GitHub' }, { status: 409 });
	const result = await poller.approve(repo, number);
	if (result === 'approved') return json({ ok: true });
	const error = {
		'not-waiting': 'Nothing waits for approval there',
		refused: 'GitHub refused to change the label',
		'label-lost': `The label came off but did not go back on: add ready-for-agent to #${number} by hand`
	}[result];
	return json({ error }, { status: result === 'not-waiting' ? 409 : 502 });
};
