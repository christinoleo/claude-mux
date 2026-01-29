import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$shared/db/index.js';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id;
	try {
		const session = getSession(id);
		if (!session) {
			return json({ error: 'Session not found', id }, { status: 404 });
		}
		return json({
			session,
			timestamp: Date.now()
		});
	} catch {
		return json({ error: 'Error reading session' }, { status: 500 });
	}
};
