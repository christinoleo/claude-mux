import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSettings, updateSettings } from '$shared/db/settings-json.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/** This machine's settings. They also ride on every sessions broadcast. */
export const GET: RequestHandler = async () => {
	return json({ settings: getSettings() });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: { autoRemoteControl?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const patch: { autoRemoteControl?: boolean } = {};
	if (typeof body.autoRemoteControl === 'boolean') patch.autoRemoteControl = body.autoRemoteControl;
	const settings = updateSettings(patch);
	broadcastSessions();
	return json({ ok: true, settings });
};
