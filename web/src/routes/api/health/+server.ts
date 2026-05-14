import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({ app: 'claude-mux', status: 'ok', timestamp: Date.now() });
};
