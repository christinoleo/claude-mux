import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { gitHistory } from '$shared/server/git-history.js';
import { sessionCommitRuns } from '$shared/transcript/commits.js';

/**
 * The commits of the repo a session sits in, newest first. `scope=all` adds
 * the branches checked out in the repo's worktrees and the upstream, which is
 * what gives the graph more than one lane. Each commit the session made itself
 * says so, with the turn of the conversation it was made in.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const history = await gitHistory(session.cwd, url.searchParams.get('scope') === 'all' ? 'all' : 'branch');
	if (!history) return json({ error: 'Not in a git work tree' }, { status: 404 });
	const runs = sessionCommitRuns(session);
	return json({
		...history,
		commits: history.commits.map((commit) => {
			const run = runs?.runAt(commit.at);
			return run ? { ...commit, mine: true, turn: run.turn } : commit;
		})
	});
};
