import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { filesRoot, listRepoFiles } from '$shared/server/files.js';

/** Every path quick-open can offer: git's tracked files and the untracked ones it does not ignore. */
export const GET: RequestHandler = async ({ params }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const { root, repo } = await filesRoot(session);
	if (!repo) return json({ error: 'Not in a git work tree' }, { status: 404 });
	const list = await listRepoFiles(root);
	if (!list) return json({ error: 'git ls-files failed' }, { status: 500 });
	return json(list);
};
