import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { APP_MARKER } from '$lib/constants';
import { MACHINE_ID } from '$lib/server/instance';
import { VERSION } from '$shared/utils/version.js';
import { PROTOCOL } from '$shared/fleet-protocol.js';

export const GET: RequestHandler = async () => {
	return json({ app: APP_MARKER, status: 'ok', instance: MACHINE_ID, version: VERSION, protocol: PROTOCOL, timestamp: Date.now() });
};
