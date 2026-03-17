import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { upsertSession } from '$shared/db/index.js';
import { homedir } from 'os';
import { join } from 'path';

/** Pre-trust a workspace directory in ~/.claude.json so Claude skips the trust dialog */
function ensureWorkspaceTrusted(cwd: string) {
	const claudeJsonPath = join(homedir(), '.claude.json');
	try {
		const data = existsSync(claudeJsonPath)
			? JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
			: {};
		if (!data.projects) data.projects = {};
		if (!data.projects[cwd]) data.projects[cwd] = {};
		if (!data.projects[cwd].hasTrustDialogAccepted) {
			data.projects[cwd].hasTrustDialogAccepted = true;
			writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2));
		}
	} catch (err) {
		console.error('[new-session] Failed to pre-trust workspace:', err);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const { cwd } = await request.json();
	if (!cwd) {
		return json({ error: 'cwd required' }, { status: 400 });
	}

	// Check if the folder exists
	if (!existsSync(cwd)) {
		return json({ error: 'Folder does not exist' }, { status: 400 });
	}
	const stat = statSync(cwd);
	if (!stat.isDirectory()) {
		return json({ error: 'Path is not a directory' }, { status: 400 });
	}

	try {
		// Pre-trust the workspace so Claude skips the trust dialog
		ensureWorkspaceTrusted(cwd);

		// Create new tmux window and run claude in the specified directory
		const sessionName = 'claude-' + Date.now();

		// Use 'env -u CLAUDECODE' so Claude doesn't refuse to start
		// (tmux server's global env may have CLAUDECODE=1 from a parent session)
		execFileSync('tmux', [
			'new-session', '-d', '-s', sessionName, '-c', cwd,
			'--', 'env', '-u', 'CLAUDECODE', 'claude', '--dangerously-skip-permissions'
		], {
			stdio: 'ignore'
		});

		// Detect actual base-index from tmux config
		const baseIndex = execFileSync('tmux', ['show-option', '-gv', 'base-index'], {
			encoding: 'utf-8'
		}).trim() || '0';
		const paneBaseIndex = execFileSync('tmux', ['show-option', '-gv', 'pane-base-index'], {
			encoding: 'utf-8'
		}).trim() || '0';
		const tmuxTarget = `${sessionName}:${baseIndex}.${paneBaseIndex}`;

		// Add session immediately so it shows up in UI
		try {
			const id = crypto.randomUUID();
			console.log('[new-session] Creating session:', { id, cwd, tmuxTarget });
			upsertSession({
				id,
				pid: 0,
				cwd,
				tmux_target: tmuxTarget,
				state: 'idle'
			});
			console.log('[new-session] Session created successfully');
		} catch (err) {
			console.error('[new-session] Session creation failed:', err);
		}

		return json({ ok: true, session: sessionName, tmuxTarget });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error('[new-session] Failed to create session:', detail);
		return json({ error: 'Failed to create session', detail }, { status: 500 });
	}
};
