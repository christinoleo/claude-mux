import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { upsertSession, type SessionAgent } from '$shared/db/index.js';
import { AGENTS, parseAgent } from '$shared/agents.js';
import { sizeArgsForNewSession } from '$shared/tmux/geometry.js';
import { homedir } from 'os';
import { join } from 'path';
import { projectSlug } from '$shared/utils/slug.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

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
	const { cwd, agent } = await request.json();
	if (!cwd) {
		return json({ error: 'cwd required' }, { status: 400 });
	}
	const selectedAgent: SessionAgent = parseAgent(agent);

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

		const sessionName = `${projectSlug(cwd, selectedAgent)}-${selectedAgent}-${Date.now()}`;

		// Strip TMUX from env so `tmux new-session` doesn't refuse with
		// "sessions should be nested with care" when the server process
		// inherited TMUX from a (possibly now-dead) parent tmux.
		const { TMUX: _tmux, TMUX_PANE: _pane, ...tmuxEnv } = process.env;

		// Unset CLAUDECODE so Claude (and harmlessly Gemini/Copilot) don't see the
		// parent tmux server's CLAUDECODE=1 and refuse to start.
		execFileSync('tmux', [
			'new-session', '-d', '-s', sessionName, '-c', cwd,
			// Detached, the window would be 80x24; the dashboard reads dialogs
			// off the screen and wants them unwrapped (see tmux/geometry).
			...sizeArgsForNewSession(),
			'--', 'env', '-u', 'CLAUDECODE', ...AGENTS[selectedAgent].argv
		], {
			stdio: 'ignore',
			env: tmuxEnv
		});

		// Detect actual base-index from tmux config
		const baseIndex = execFileSync('tmux', ['show-option', '-gv', 'base-index'], {
			encoding: 'utf-8',
			env: tmuxEnv
		}).trim() || '0';
		const paneBaseIndex = execFileSync('tmux', ['show-option', '-gv', 'pane-base-index'], {
			encoding: 'utf-8',
			env: tmuxEnv
		}).trim() || '0';
		const tmuxTarget = `${sessionName}:${baseIndex}.${paneBaseIndex}`;

		const record = upsertSession({
			id: crypto.randomUUID(),
			pid: 0,
			cwd,
			tmux_target: tmuxTarget,
			state: 'idle',
			agent: selectedAgent
		});
		// The sidebar sees the row now, not at the watcher's next poll.
		broadcastSessions();

		return json({ ok: true, session: sessionName, tmuxTarget, agent: selectedAgent, record });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error('[new-session] Failed to create session:', detail);
		return json({ error: 'Failed to create session', detail }, { status: 500 });
	}
};
