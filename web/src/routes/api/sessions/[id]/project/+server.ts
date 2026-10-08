import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { projectInfo } from '$shared/server/project.js';

/** The project a session works in: repo root, branch, and `.claude-mux.json`. */
export const GET: RequestHandler = async ({ params }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	return json(await projectInfo(session.cwd));
};
