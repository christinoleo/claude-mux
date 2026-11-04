import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { dialogHolds } from '$shared/server/dialog-holds.js';

const EventSchema = z.object({
	hook_event_name: z.string(),
	session_id: z.string(),
	tool_name: z.string().optional(),
	tool_input: z.unknown().optional(),
	agent_id: z.string().optional()
});

/**
 * `PostToolUse`, `PostToolUseFailure` and `Stop`, which end a hold when a person
 * answered in the terminal. They fire for every tool in every session, with the
 * tool's whole response, so with nothing held the request goes unread. As with
 * the hold, a request with an `Origin` is a page's, and is refused.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (request.headers.has('origin')) return json({ error: 'Forbidden' }, { status: 403 });
	if (!dialogHolds.any) return json({});

	const parsed = EventSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return json({ error: 'Not a hook event' }, { status: 400 });

	const { hook_event_name: event, session_id, tool_name, tool_input, agent_id } = parsed.data;
	if (event === 'Stop') dialogHolds.turnEnded(session_id);
	// No subagent's call is held.
	else if (tool_name && !agent_id) dialogHolds.toolFinished(session_id, tool_name, tool_input);
	return json({});
};
