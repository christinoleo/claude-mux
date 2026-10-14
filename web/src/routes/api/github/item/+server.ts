import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isRepoSlug, parseRefNumber } from '$shared/github-ref.js';
import { githubItems } from '$shared/server/github-items.js';

/**
 * One pull request or issue whole, for the side panel's GitHub pane:
 * `?repo=owner/name&number=n`. Answers `{ item, stale }`, `stale` when a
 * refresh failed and this is the last good read, or `{ item: null, error }`
 * with `no-gh` (`gh` missing or logged out), `not-found` or `failed`.
 */
export const GET: RequestHandler = async ({ url }) => {
	const number = parseRefNumber(url.searchParams.get('number'));
	if (number === null) return json({ error: 'number must be a positive integer' }, { status: 400 });
	const repo = url.searchParams.get('repo');
	if (repo === null || !isRepoSlug(repo)) return json({ error: 'repo must be owner/name' }, { status: 400 });
	return json(await githubItems.read(repo, number));
};
