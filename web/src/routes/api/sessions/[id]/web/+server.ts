import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';
import { repoRoot } from '$shared/server/git.js';
import { readProjectConfig } from '$shared/server/project.js';
import { detectDevServers, tailscaleServes, type WebInfo } from '$shared/server/web-preview.js';

/**
 * What the Web pane shows for a session's project: the URLs `.claude-mux.json`
 * names, the dev servers running inside the project, and how tailscale serve
 * maps local ports to HTTPS. The pane polls this while it is open. Outside a
 * repo nothing is detected: a session started in the home directory would
 * otherwise claim every server the user runs.
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = decodeURIComponent(params.id);
	const session = getSession(id);
	if (!session) return json({ error: 'Session not found', id }, { status: 404 });
	const servesP = tailscaleServes();
	const repo = await repoRoot(session.cwd);
	const root = repo ?? session.cwd;
	const [{ config, configError }, detected, serves] = await Promise.all([
		readProjectConfig(root),
		repo ? detectDevServers(repo) : [],
		servesP
	]);
	const info: WebInfo = { root, urls: config?.urls ?? {}, configError, detected, serves };
	return json(info);
};
