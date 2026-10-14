import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { currentBranch } from '$shared/server/git.js';
import { repoSlugFor } from '$shared/server/github.js';
import { githubItems } from '$shared/server/github-items.js';

/**
 * What the GitHub pane shows for a session before anyone picks something:
 * the repo it sits in, the pull request of the branch it has checked out,
 * and the issue it works on as a maestro worker. Each is null when there is
 * none, or when `gh` cannot say.
 */
export const GET: RequestHandler = async ({ params }) => {
	const session = getSession(decodeURIComponent(params.id));
	if (!session) return json({ error: 'Session not found' }, { status: 404 });
	const repo = repoSlugFor(session.git_root);
	const issue = session.maestro_issue ?? null;
	if (!repo) return json({ repo: null, pull: null, issue: null });
	const branch = await currentBranch(session.git_root ?? session.cwd);
	const pull = branch ? await githubItems.branchPull(repo, branch) : null;
	return json({ repo, pull, issue });
};
