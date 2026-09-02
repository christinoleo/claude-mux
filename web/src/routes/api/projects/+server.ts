import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSavedProjects, removeProject, saveProject } from '$shared/db/projects-json.js';
import { broadcastSessions } from '$lib/server/ws-managers.js';

/**
 * The projects the sidebar groups sessions under, as the server remembers
 * them. The list also rides on every sessions broadcast; these endpoints are
 * how a browser adds one before its first session exists (the folder picker,
 * or a list migrated from its own localStorage) and how it closes a group.
 */
export const GET: RequestHandler = async () => {
	return json({ projects: getSavedProjects() });
};

async function readCwd(request: Request): Promise<string | null> {
	try {
		const body = (await request.json()) as { cwd?: unknown };
		return typeof body.cwd === 'string' && body.cwd.startsWith('/') ? body.cwd : null;
	} catch {
		return null;
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const cwd = await readCwd(request);
	if (!cwd) return json({ error: 'cwd must be an absolute path' }, { status: 400 });
	if (saveProject(cwd)) broadcastSessions();
	return json({ ok: true, projects: getSavedProjects() });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const cwd = await readCwd(request);
	if (!cwd) return json({ error: 'cwd must be an absolute path' }, { status: 400 });
	if (removeProject(cwd)) broadcastSessions();
	return json({ ok: true, projects: getSavedProjects() });
};
