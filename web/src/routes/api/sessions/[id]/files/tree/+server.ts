import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { FileAccessError, filesRoot, listDir } from '$shared/server/files.js';

/**
 * One directory of the session's project (`dir`, relative to the root; empty
 * for the root). Ignored entries are left out unless `ignored=1`.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const { root, repo } = await filesRoot(session);
	try {
		const listing = await listDir(root, url.searchParams.get('dir') ?? '', {
			repo,
			showIgnored: url.searchParams.get('ignored') === '1'
		});
		return json(listing);
	} catch (err) {
		if (err instanceof FileAccessError) return json({ error: err.message }, { status: err.status });
		throw err;
	}
};
