import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { APP_MARKER } from '$lib/constants';

export const GET: RequestHandler = async () => {
	return json({ app: APP_MARKER, status: 'ok', timestamp: Date.now() });
};
