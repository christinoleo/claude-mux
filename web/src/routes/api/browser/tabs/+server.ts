import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { browserInfo } from '$shared/server/browser-view.js';
import { resolveTranscriptPath } from '$shared/transcript/tailer.js';

/**
 * The tabs of the remote browser the Web pane's Browser source shows, and
 * with `?session=<id>` the one that session last opened or selected. The
 * browser being off is an answer (`error`), not a failure.
 */
export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('session');
	return json(
		await browserInfo(() => {
			const session = id ? getSession(id) : null;
			return session && id ? resolveTranscriptPath(session, id) : null;
		})
	);
};
