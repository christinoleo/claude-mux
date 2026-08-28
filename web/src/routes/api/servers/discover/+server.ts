import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DiscoverResponse } from '$lib/types/servers';
import { discoverServers } from '$lib/server/discover';

export const GET: RequestHandler = async ({ url }) => {
	const result = await discoverServers(url.port || '3456');
	if (result.error) {
		return json({ servers: [], self: '', error: result.error } satisfies DiscoverResponse, {
			status: 500
		});
	}
	return json({ servers: result.servers, self: result.self } satisfies DiscoverResponse);
};
