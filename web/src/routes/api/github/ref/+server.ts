import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { isRepoSlug, parseRefNumber } from '$shared/github-ref.js';
import { repoSlugFor } from '$shared/server/github.js';
import { readGithubRef } from '$shared/server/github-refs.js';

/**
 * What GitHub says about one pull request or issue: `?repo=owner/name&number=n`,
 * or `?session=<id>&number=n` for a bare `#n` in that session's own repo.
 * `ref` is null whenever there is nothing to say (`gh` missing or logged out,
 * a repo it cannot see, no such number), so the link stays a plain link.
 */
export const GET: RequestHandler = async ({ url }) => {
	const number = parseRefNumber(url.searchParams.get('number'));
	if (number === null) return json({ error: 'number must be a positive integer' }, { status: 400 });

	const named = url.searchParams.get('repo');
	if (named !== null && !isRepoSlug(named)) return json({ error: 'repo must be owner/name' }, { status: 400 });
	const session = url.searchParams.get('session');
	const repo = named ?? (session ? repoSlugFor(getSession(session)?.git_root) : null);

	return json({ ref: repo ? await readGithubRef(repo, number) : null });
};
