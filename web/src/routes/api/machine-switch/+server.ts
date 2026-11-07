import { json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { readMachineSwitch, setMachineSwitch } from '$shared/server/machine-switch.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { listenPort } from '$lib/server/instance';
import { workerQueue } from '$lib/server/worker-queue.js';

/**
 * This machine's one switch (`src/server/machine-switch.ts`): workers,
 * Triggers, the release rule, live text and dashboard approvals. Another
 * machine's is reached through the fleet relay.
 */
export const GET: RequestHandler = async () => json(readMachineSwitch({ dev }));

/** `{ on }`. */
export const POST: RequestHandler = async ({ request }) => {
	// A text/plain POST passes SvelteKit's CSRF check, and this one decides what
	// starts on the machine and writes the settings every Claude Code there reads:
	// only this server's own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as { on?: unknown } | null;
	if (typeof body?.on !== 'boolean') return json({ error: 'on must be true or false' }, { status: 400 });
	try {
		if (!setMachineSwitch(body.on, { dev, port: listenPort() })) {
			return json({ error: 'A dev server does not change this machine’s switch' }, { status: 409 });
		}
	} catch (err) {
		return json({ error: `Could not turn the switch: ${String(err)}` }, { status: 500 });
	}
	// From what the last read of GitHub found; the answer does not wait for it.
	void workerQueue()?.tick();
	return json(readMachineSwitch({ dev }));
};
