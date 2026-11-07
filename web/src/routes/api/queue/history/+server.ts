import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HISTORY_DAYS } from '$shared/server/worker-queue.js';
import { workerQueue } from '$lib/server/worker-queue.js';

/** Every run this machine's queue keeps (the last `HISTORY_DAYS` days), newest first; the page picks its period. */
export const GET: RequestHandler = async () => json({ runs: workerQueue()?.history(HISTORY_DAYS) ?? [] });
