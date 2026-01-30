import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { deleteSession } from '$shared/db/index.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = decodeURIComponent(params.id);
	const body = await request.json().catch(() => ({}));
	const { pid, tmux_target, cwd } = body;

	if (!tmux_target || typeof tmux_target !== 'string') {
		return json({ error: 'tmux_target required' }, { status: 400 });
	}

	if (!cwd || typeof cwd !== 'string') {
		return json({ error: 'cwd required' }, { status: 400 });
	}

	try {
		// Kill the Claude process first (but keep the tmux pane)
		if (typeof pid === 'number' && pid > 0 && Number.isInteger(pid)) {
			try {
				// Use SIGKILL for faster termination
				execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
			} catch {
				// Process may not exist - ignore
			}
		}

		// Remove old session file (hooks will create a new one when Claude starts)
		try {
			deleteSession(id);
		} catch {
			// Cleanup is best-effort
		}

		// Wait for the process to die and shell to be ready
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Send Ctrl-C first to ensure we're at a clean shell prompt
		// (in case the shell is showing exit status or waiting for input)
		execFileSync('tmux', ['send-keys', '-t', tmux_target, 'C-c'], {
			stdio: 'ignore'
		});

		// Small delay for Ctrl-C to be processed
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Start a fresh Claude process in the same pane
		// First cd to the correct directory, then start claude
		execFileSync('tmux', ['send-keys', '-t', tmux_target, `cd "${cwd}" && claude --dangerously-skip-permissions`, 'Enter'], {
			stdio: 'ignore'
		});

		return json({ ok: true });
	} catch (err) {
		return json({ error: 'Failed to restart session' }, { status: 500 });
	}
};
