import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { sessionChanges } from '$shared/transcript/changes.js';
import { confinePath, gitFileDiff, repoRoot } from '$shared/server/git.js';

/**
 * One file's diff. `source=git` diffs the working tree against HEAD, and
 * only for a file inside the repo that git lists as changed. `source=session`
 * returns the hunks the session's log recorded for the file — over the whole
 * session, or within one turn when `turn` names its prompt's id.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const source = url.searchParams.get('source');
	const file = url.searchParams.get('file');
	if (source !== 'git' && source !== 'session') {
		return json({ error: 'source must be git or session' }, { status: 400 });
	}
	if (!file) return json({ error: 'file is required' }, { status: 400 });

	if (source === 'git') {
		const root = await repoRoot(session.cwd);
		if (!root) return json({ error: 'Not in a git work tree' }, { status: 404 });
		if (!confinePath(root, file)) {
			return json({ error: 'Path is outside the repository' }, { status: 400 });
		}
		const diff = await gitFileDiff(session.cwd, file);
		if (!diff) return json({ error: 'No change to that file', file }, { status: 404 });
		return json({ source, ...diff });
	}

	const turn = url.searchParams.get('turn');
	const change = sessionChanges(session)?.file(file, turn ?? undefined);
	if (!change) return json({ error: 'No change to that file', file }, { status: 404 });
	return json({ source, file: change.file, kind: change.kind, binary: false, hunks: change.hunks });
};
