import { json } from '@sveltejs/kit';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { CLAUDE_MUX_DIR } from '$shared/utils/paths.js';
import { VERSION } from '$shared/utils/version.js';
import { PROTOCOL } from '$shared/fleet-protocol.js';
import { readUpdateJob, startUpdate } from '$shared/server/self-update.js';

const UPDATE_DIR = join(CLAUDE_MUX_DIR, 'update');

/** What this machine runs, and its last update started from the page (`src/server/self-update.ts`). */
export const GET: RequestHandler = async () => {
	return json({ version: VERSION, protocol: PROTOCOL, job: readUpdateJob(UPDATE_DIR) });
};

/**
 * Run `claude-mux update` here, detached, since it ends by restarting this
 * server. 202 with the job once started, 409 with it while one already runs.
 */
export const POST: RequestHandler = async () => {
	const { started, job } = startUpdate({ dir: UPDATE_DIR, fromVersion: VERSION });
	return json({ version: VERSION, protocol: PROTOCOL, job }, { status: started ? 202 : 409 });
};
