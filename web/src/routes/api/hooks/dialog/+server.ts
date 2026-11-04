import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/sessions-json.js';
import { dialogHolds } from '$shared/server/dialog-holds.js';

const PermissionRequestSchema = z.object({
	session_id: z.string().regex(/^[\w-]+$/),
	tool_name: z.string(),
	tool_input: z.record(z.string(), z.unknown()).optional(),
	agent_id: z.string().optional()
});

/**
 * Claude Code's `PermissionRequest` hook, over `http`. No token: Claude Code
 * sends no `Origin` and a browser always does, and the relay puts one on what it
 * forwards, so this is the local hook only, and no page can hold a dialog.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (request.headers.has('origin')) return json({ error: 'Forbidden' }, { status: 403 });

	const call = PermissionRequestSchema.safeParse(await request.json().catch(() => null));
	if (!call.success) return json({ error: 'Not a PermissionRequest' }, { status: 400 });

	// Nothing here could draw a card for a session it does not know.
	if (!getSession(call.data.session_id)) return json({});
	return json(await dialogHolds.hold({ tool_input: {}, ...call.data }, request.signal));
};
