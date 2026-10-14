import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { upsertSession, type SessionAgent } from '$shared/db/index.js';
import { AGENTS } from '$shared/agents.js';
import { sizeArgsForNewSession } from '$shared/tmux/geometry.js';
import { tmuxNewSession } from '$shared/tmux/server.js';
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

export interface StartSession {
	cwd: string;
	agent: SessionAgent;
	/** Arguments after the agent's own command line: a first prompt, or `--resume <transcript>`. */
	args?: string[];
	/** The id the row is registered under until the hooks speak: a resumed session's own. */
	id?: string;
}

/**
 * Start an agent in a tmux session of its own in `cwd`, and register its row
 * so the sidebar sees it now, not at the watcher's next poll. Throws when tmux
 * cannot start it.
 */
export function startSession({ cwd, agent, args = [], id }: StartSession) {
	// Pre-trust the workspace so Claude skips the trust dialog
	ensureWorkspaceTrusted(cwd);

	const sessionName = `${projectSlug(cwd, agent)}-${agent}-${Date.now()}`;

	// Strip TMUX from env so `tmux new-session` doesn't refuse with
	// "sessions should be nested with care" when the server process
	// inherited TMUX from a (possibly now-dead) parent tmux.
	const { TMUX: _tmux, TMUX_PANE: _pane, ...tmuxEnv } = process.env;

	// Unset CLAUDECODE so Claude (and harmlessly Gemini/Copilot) don't see the
	// parent tmux server's CLAUDECODE=1 and refuse to start.
	// The first session after boot starts the tmux server; tmuxNewSession keeps
	// it out of this service's cgroup so a restart does not close every pane.
	tmuxNewSession([
		'-d', '-s', sessionName, '-c', cwd,
		// Detached, the window would be 80x24; the dashboard reads dialogs
		// off the screen and wants them unwrapped (see tmux/geometry).
		...sizeArgsForNewSession(),
		'--', 'env', '-u', 'CLAUDECODE', ...AGENTS[agent].argv,
		...args
	], tmuxEnv);

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
		id: id ?? crypto.randomUUID(),
		pid: 0,
		cwd,
		tmux_target: tmuxTarget,
		state: 'idle',
		agent
	});
	broadcastSessions();
	return { sessionName, tmuxTarget, record };
}
