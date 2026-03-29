import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { sendTextToPane } from '$shared/server/message-queue.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const keys = body.keys || 'Escape';
	const text = body.text; // For literal text input

	try {
		if (text) {
			sendTextToPane(target, text);
		} else {
			// Send each key separately so repeated keys (e.g. C-b C-b) work correctly
			for (const key of keys.split(' ')) {
				execFileSync('tmux', ['send-keys', '-t', target, key], { stdio: 'ignore' });
			}
		}
		return json({ ok: true });
	} catch {
		return json({ error: 'Failed to send keys' }, { status: 500 });
	}
};
