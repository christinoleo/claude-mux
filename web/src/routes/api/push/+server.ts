import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { vapidKeys } from '$lib/server/push.js';

/** The key a device subscribes with. Made on first ask, then kept. */
export const GET: RequestHandler = () => json({ publicKey: vapidKeys().publicKey });
