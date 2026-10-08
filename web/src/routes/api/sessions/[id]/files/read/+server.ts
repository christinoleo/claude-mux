import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import {
	FileAccessError,
	filesRoot,
	readProjectFile,
	readProjectImage
} from '$shared/server/files.js';

/**
 * One file of the session's project. Text comes back as JSON, cut at 1 MB
 * (`truncated`); an image answers `kind: 'image'`, and with `raw=1` its bytes;
 * a binary answers 415.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const path = url.searchParams.get('path');
	if (!path) return json({ error: 'path is required' }, { status: 400 });
	const { root } = await filesRoot(session);
	try {
		if (url.searchParams.get('raw') === '1') {
			const { bytes, mime } = await readProjectImage(root, path);
			return new Response(new Uint8Array(bytes), {
				headers: {
					'Content-Type': mime,
					'Content-Length': String(bytes.length),
					'Cache-Control': 'private, max-age=60',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		}
		const file = await readProjectFile(root, path);
		if (file.kind === 'binary') {
			return json({ error: 'Binary file', binary: true, path: file.path, size: file.size }, { status: 415 });
		}
		return json(file);
	} catch (err) {
		if (err instanceof FileAccessError) return json({ error: err.message }, { status: err.status });
		throw err;
	}
};
