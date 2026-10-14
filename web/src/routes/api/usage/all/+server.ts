import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discoverServers, selfName } from '$lib/server/discover';
import { ensureFleetState } from '$lib/server/fleet';
import { parseUsageQuery } from '../../../../../../src/usage/report.js';
import { buildFleetReport } from '../../../../../../src/usage/fleet.js';

/**
 * Cost across every machine in the fleet.
 *
 * The machines are the fleet state's, not a fresh discovery: one that is off
 * is reported as such at once rather than waited on. Each one that is online
 * scans its own transcripts and answers with buckets. The fan-out runs on the
 * server rather than in the browser so `/api/usage` never needs cross-origin
 * headers, which would let any page the user visits read their usage.
 */
export const GET: RequestHandler = async ({ url, fetch }) => {
	const query = parseUsageQuery(url.searchParams);
	const known = ensureFleetState().snapshot();
	// Before the fleet state has met anyone (a first start), ask the tailnet directly.
	if (known.length === 0) return json(await buildFleetReport({ ...query, discover: discoverServers, fetch }));
	const discover = async () => ({
		self: selfName(),
		servers: known
			.map((m) => ({
				hostname: m.hostname,
				url: m.url,
				online: m.online,
				reason: m.online ? undefined : m.lastSeen ? `offline, last seen ${new Date(m.lastSeen).toISOString()}` : 'offline'
			}))
	});
	return json(await buildFleetReport({ ...query, discover, fetch }));
};
