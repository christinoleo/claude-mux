import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { transcriptWsManager } from '$lib/server/ws-managers.js';
import { LiveBatchSchema } from '$shared/transcript/live-text.js';

/**
 * Claude Code's `MessageDisplay` hook, over `http` with `timeout: 1`. The call
 * holds the session's screen until it is answered, so this only stores the
 * batch. No token: Claude Code sends no `Origin` and a browser always does,
 * and the relay puts one on what it forwards, so this is the local hook only.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (request.headers.has('origin')) return json({ error: 'Forbidden' }, { status: 403 });

	const batch = LiveBatchSchema.safeParse(await request.json().catch(() => null));
	if (!batch.success) return json({ error: 'Not a MessageDisplay batch' }, { status: 400 });

	if (!transcriptWsManager.acceptLiveText(batch.data)) return json({ error: 'Unknown session' }, { status: 404 });
	return json({});
};
