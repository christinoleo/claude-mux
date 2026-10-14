import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, statSync } from 'fs';
import type { SessionAgent } from '$shared/db/index.js';
import { parseAgent } from '$shared/agents.js';
import { startSession } from '$lib/server/start-session.js';

export const POST: RequestHandler = async ({ request }) => {
	const { cwd, agent, prompt } = await request.json();
	if (!cwd) {
		return json({ error: 'cwd required' }, { status: 400 });
	}
	const selectedAgent: SessionAgent = parseAgent(agent);
	// A first prompt rides Claude Code's own command line, which runs it once
	// the session is up; the send queue would paste it before there is a box.
	const firstPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null;
	if (firstPrompt && selectedAgent !== 'claude') {
		return json({ error: 'A first prompt is only supported for Claude Code' }, { status: 400 });
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
		const { sessionName, tmuxTarget, record } = startSession({
			cwd,
			agent: selectedAgent,
			args: firstPrompt ? [firstPrompt] : []
		});
		return json({ ok: true, session: sessionName, tmuxTarget, agent: selectedAgent, record });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error('[new-session] Failed to create session:', detail);
		return json({ error: 'Failed to create session', detail }, { status: 500 });
	}
};
