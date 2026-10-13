import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { commitFileDiff } from '$shared/server/git-history.js';

/** One file's diff within a commit, against the commit's first parent. */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const file = url.searchParams.get('file');
	if (!file) return json({ error: 'file is required' }, { status: 400 });
	const diff = await commitFileDiff(session.cwd, url.searchParams.get('hash') ?? '', file);
	if (!diff) return json({ error: 'No such file in that commit', file }, { status: 404 });
	return json(diff);
};
