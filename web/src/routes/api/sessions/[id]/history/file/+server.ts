import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { commitFileText } from '$shared/server/git-history.js';

/** A file's text as a commit left it, which is where a diff's hidden lines are read from. */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const file = url.searchParams.get('file');
	if (!file) return json({ error: 'file is required' }, { status: 400 });
	const read = await commitFileText(session.cwd, url.searchParams.get('hash') ?? '', file);
	if (!read) return json({ error: 'No text for that file in that commit', file }, { status: 404 });
	return json(read);
};
