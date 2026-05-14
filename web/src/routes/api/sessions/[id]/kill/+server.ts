import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { deleteSession } from '$shared/db/index.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = decodeURIComponent(params.id);
	const body = await request.json().catch(() => ({}));
	const { pid, tmux_target } = body;

	try {
		// Kill the Claude process first (use SIGKILL since SIGTERM may be ignored)
		if (typeof pid === 'number' && pid > 0 && Number.isInteger(pid)) {
			try {
				execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
			} catch {
				// Process may not exist - ignore
			}
		}

		// Kill only the specific tmux pane (not the entire session)
		if (tmux_target && typeof tmux_target === 'string') {
			try {
				execFileSync('tmux', ['kill-pane', '-t', tmux_target], { stdio: 'ignore' });
			} catch {
				// Pane may not exist - ignore
			}
		}

		// Remove session file
		try {
			deleteSession(id);
		} catch {
			// Cleanup is best-effort
		}
		broadcastSessions();
		return json({ ok: true });
	} catch {
		// Even if kill fails, clean up session
		try {
			deleteSession(id);
		} catch {
			// Ignore
		}
		broadcastSessions();
		return json({ ok: true });
	}
};
