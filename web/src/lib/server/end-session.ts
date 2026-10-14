import { execFileSync } from 'child_process';
import { deleteSession } from '$shared/db/index.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/**
 * End a session: its Claude process killed, its pane closed, its JSON gone.
 * The transcript stays, so the conversation is a past session from here on.
 * Every step is best-effort; whatever is already gone is skipped.
 */
export function endSession(id: string, pid: unknown, tmuxTarget: unknown): void {
	// SIGKILL, since SIGTERM may be ignored.
	if (typeof pid === 'number' && pid > 0 && Number.isInteger(pid)) {
		try {
			execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
		} catch {
			// Process may not exist.
		}
	}
	// Only the session's own pane, never its whole tmux session.
	if (tmuxTarget && typeof tmuxTarget === 'string') {
		try {
			execFileSync('tmux', ['kill-pane', '-t', tmuxTarget], { stdio: 'ignore' });
		} catch {
			// Pane may not exist.
		}
	}
	try {
		deleteSession(id);
	} catch {
		// Cleanup is best-effort.
	}
	broadcastSessions();
}
