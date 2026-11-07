import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { workerQueue } from '$lib/server/worker-queue.js';

/**
 * `{ repo, number }`: stops that worker of this machine's queue, and puts its
 * issue on hold so no machine starts it again (`WorkerQueue.stop()`).
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const queue = workerQueue();
	if (!queue) return json({ error: 'This server does not read GitHub, so it runs no workers' }, { status: 409 });
	const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown } | null;
	if (typeof body?.repo !== 'string' || typeof body.number !== 'number' || !Number.isInteger(body.number)) {
		return json({ error: 'repo and number are required' }, { status: 400 });
	}
	const error = await queue.stop(body.repo, body.number);
	if (error) return json({ error }, { status: 404 });
	return json({ ok: true, status: queue.status() });
};
