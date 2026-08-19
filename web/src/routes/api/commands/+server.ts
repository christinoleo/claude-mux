import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discoverCommands } from '$shared/claude/commands.js';

/** GET /api/commands?cwd=/path → slash commands, skills, and agents visible to Claude Code. */
export const GET: RequestHandler = async ({ url }) => {
	const cwd = url.searchParams.get('cwd') || undefined;
	return json({ commands: discoverCommands(cwd) });
};
