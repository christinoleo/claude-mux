import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { deleteSession } from '$shared/db/index.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = decodeURIComponent(params.id);
	const body = await request.json().catch(() => ({}));
	const { pid, tmux_target } = body;

	try {
		// Kill the Claude process first
		if (typeof pid === 'number' && pid > 0 && Number.isInteger(pid)) {
			try {
				execFileSync('kill', [String(pid)], { stdio: 'ignore' });
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
		return json({ ok: true });
	} catch {
		// Even if kill fails, clean up session
		try {
			deleteSession(id);
		} catch {
			// Ignore
		}
		return json({ ok: true });
	}
};
