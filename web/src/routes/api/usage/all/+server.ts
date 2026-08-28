import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discoverServers } from '$lib/server/discover';
import { parseUsageQuery } from '../../../../../../src/usage/report.js';
import { buildFleetReport } from '../../../../../../src/usage/fleet.js';

/**
 * Cost across every claude-mux on the tailnet.
 *
 * The fan-out runs on the server rather than in the browser so `/api/usage`
 * never needs cross-origin headers, which would let any page the user visits
 * read their usage.
 */
export const GET: RequestHandler = async ({ url, fetch }) => {
	const query = parseUsageQuery(url.searchParams);
	// Peers are probed on the port they serve, which is not necessarily the one
	// this request arrived on — a dev server on 3434 still aggregates hosts
	// running the service on 3456.
	const port = url.searchParams.get('port') || url.port || '3456';

	return json(
		await buildFleetReport({
			...query,
			discover: () => discoverServers(port),
			fetch
		})
	);
};
