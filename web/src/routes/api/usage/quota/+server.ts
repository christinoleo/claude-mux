import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchQuota } from '../../../../../../src/usage/quota.js';

/**
 * Subscription quota for the account signed in on this host.
 *
 * Account-level, not host-level: the same plan is shared across every machine,
 * so callers aggregating several hosts must show this once rather than summing
 * it. Always 200 — an unavailable quota is a state to render, not an error.
 */
export const GET: RequestHandler = async () => {
	return json(await fetchQuota());
};
