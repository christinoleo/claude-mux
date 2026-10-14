import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AlignPlanSchema } from '$shared/fleet-plugins.js';
import { alignPlugins, pluginReader } from '$shared/server/plugins.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { sessionsWsManager } from '$lib/server/ws-managers.js';

/** This machine's marketplaces and plugins (`src/server/plugins.ts`), read afresh. */
export const GET: RequestHandler = async () => {
	return json({ plugins: await pluginReader().refresh() });
};

/**
 * "Bring in line": update the marketplaces, then install and enable what the
 * plan names (`alignPlan()` in `src/fleet-plugins.ts`, worked out by the page
 * from the whole fleet). Answers each step's command and output, and the
 * report read after.
 */
export const POST: RequestHandler = async ({ request }) => {
	// This installs software: only this server's own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const parsed = AlignPlanSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return json({ error: 'invalid plan' }, { status: 400 });
	const result = await alignPlugins(parsed.data, pluginReader());
	sessionsWsManager.broadcastNow();
	return json({ steps: result.steps, plugins: result.report });
};
