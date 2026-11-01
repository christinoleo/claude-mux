import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSettings, updateSettings, type Settings } from '$shared/db/settings-json.js';
import { readClaudeUpdateStatus } from '$shared/server/claude-update.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/** This machine's settings. They also ride on every sessions broadcast. */
export const GET: RequestHandler = async () => {
	return json({ settings: getSettings(), claudeUpdate: readClaudeUpdateStatus() });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Partial<Settings>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const settings = updateSettings(body);
	broadcastSessions();
	return json({ ok: true, settings });
};
