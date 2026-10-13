import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { commitFiles } from '$shared/server/git-history.js';

/** The files one commit changed. `hash` is a commit hash and nothing else. */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const commit = await commitFiles(session.cwd, url.searchParams.get('hash') ?? '');
	if (!commit) return json({ error: 'No such commit here' }, { status: 404 });
	return json(commit);
};
