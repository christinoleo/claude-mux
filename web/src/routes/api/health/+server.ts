import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { APP_MARKER } from '$lib/constants';
import { MACHINE_ID } from '$lib/server/instance';

export const GET: RequestHandler = async () => {
	return json({ app: APP_MARKER, status: 'ok', instance: MACHINE_ID, timestamp: Date.now() });
};
