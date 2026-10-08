import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { sessionChanges, summarize } from '$shared/transcript/changes.js';
import { gitChanges } from '$shared/server/git.js';

/**
 * The files a session changed, with line counts. `source=git` reads the
 * working tree of the repo the session sits in; `source=session` reads the
 * session's own log, and groups the files by turn as well. Without a source,
 * git when the session is in a repo, else the log.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const source = url.searchParams.get('source');
	if (source !== null && source !== 'git' && source !== 'session') {
		return json({ error: 'source must be git or session' }, { status: 400 });
	}

	if (source !== 'session') {
		const git = await gitChanges(session.cwd);
		if (git) {
			return json({ source: 'git', root: git.root, files: git.files, totals: summarize(git.files) });
		}
		if (source === 'git') return json({ error: 'Not in a git work tree' }, { status: 404 });
	}

	const collector = sessionChanges(session);
	const files = collector?.counts() ?? [];
	return json({
		source: 'session',
		files,
		turns: collector?.byTurn() ?? [],
		totals: summarize(files)
	});
};
