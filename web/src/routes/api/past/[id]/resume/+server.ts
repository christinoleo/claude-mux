import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { statSync } from 'fs';
import { getSavedProjects } from '$shared/db/index.js';
import { getEnrichedSessionsAsync } from '$shared/server/ws-handlers.js';
import { planResume } from '$shared/server/past-resume.js';
import { findTranscriptById } from '$shared/transcript/tailer.js';
import { readPastSession } from '$shared/transcript/past-sessions.js';
import { startSession } from '$lib/server/start-session.js';

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resume a past session on this machine: `claude --resume <transcript>` in a
 * tmux session of its own, in the folder it ran in, or in `cwd` when the
 * person chose the project's root because that folder is gone (answered 409
 * with the root to offer). A session already live answers with its pane, and
 * nothing is started.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = decodeURIComponent(params.id);
	const body = await request.json().catch(() => ({}));
	const transcript = findTranscriptById(id);
	const [sessions, past] = await Promise.all([
		getEnrichedSessionsAsync(),
		transcript ? readPastSession(transcript) : null
	]);
	const plan = planResume({
		id,
		cwd: typeof body?.cwd === 'string' && body.cwd ? body.cwd : null,
		sessions,
		transcript,
		ranIn: past?.cwd ?? null,
		projects: getSavedProjects(),
		isDir
	});
	switch (plan.kind) {
		case 'live':
			return json({ ok: true, live: true, tmuxTarget: plan.target });
		case 'unknown':
			return json({ error: 'No transcript for this session on this machine' }, { status: 404 });
		case 'folder-gone':
			return json({ error: 'The folder it ran in is gone', cwd: plan.cwd, root: plan.root }, { status: 409 });
		case 'start':
			try {
				// Registered under its own id, so it leaves the past list at once.
				const { tmuxTarget } = startSession({
					cwd: plan.cwd,
					agent: 'claude',
					args: ['--resume', plan.transcript],
					id
				});
				return json({ ok: true, live: false, tmuxTarget });
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return json({ error: 'Failed to resume', detail }, { status: 500 });
			}
	}
};
