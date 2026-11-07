import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { parseSettingsPatch } from '$shared/server/worker-queue.js';
import { dev } from '$app/environment';
import { readMachineSwitch } from '$shared/server/machine-switch.js';
import { workerQueue } from '$lib/server/worker-queue.js';

/**
 * This machine's worker queue (`src/server/worker-queue.ts`): whether the
 * machine's switch is on, its limit and memory brake, the workers it started and why each ready issue
 * waits. `running` is false on a server that does not poll GitHub (a dev
 * server not told to), which starts nothing.
 */
export const GET: RequestHandler = async () => {
	const queue = workerQueue();
	return json({ running: queue !== null, status: queue?.status() ?? null, switchable: readMachineSwitch({ dev }).switchable });
};

/** `{ limit?, minFreeGiB?, maxPressure? }`; the switch is `/api/machine-switch`. */
export const POST: RequestHandler = async ({ request }) => {
	// This decides whether sessions start on this machine: only its own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const queue = workerQueue();
	if (!queue) return json({ error: 'This server does not read GitHub, so it starts no workers' }, { status: 409 });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const patch = parseSettingsPatch(body);
	if (typeof patch === 'string') return json({ error: patch }, { status: 400 });
	queue.update(patch);
	// From what the last read of GitHub found; the answer does not wait for it.
	void queue.tick();
	return json({ ok: true, running: true, status: queue.status() });
};
