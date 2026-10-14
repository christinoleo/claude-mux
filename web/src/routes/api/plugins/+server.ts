import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AlignPlanSchema, type AlignAnswer } from '$shared/fleet-plugins.js';
import { pluginReader } from '$shared/server/plugins.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { sessionsWsManager } from '$lib/server/ws-managers.js';

/** The last "Bring in line" run on this machine, read by the page until it ends. */
export const GET: RequestHandler = async () => {
	return json({ job: pluginReader().alignJob(), now: Date.now() } satisfies AlignAnswer);
};

/**
 * "Bring in line": update the marketplaces that are behind, then install and
 * enable what the plan names (`alignPlan()` in `src/fleet-plugins.ts`, worked
 * out by the page from the whole fleet). Runs in the background and answers
 * at once with the job, 202 when started and 409 when one already running was
 * joined; `GET` reads it from there.
 */
export const POST: RequestHandler = async ({ request }) => {
	// This installs software: only this server's own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const parsed = AlignPlanSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return json({ error: 'invalid plan' }, { status: 400 });
	const { started, job } = pluginReader().startAlign(parsed.data, () => sessionsWsManager.broadcastNow());
	return json({ job, now: Date.now(), started } satisfies AlignAnswer, { status: started ? 202 : 409 });
};
