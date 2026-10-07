import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { confirmSubmitted, sendTextToPane } from '$shared/server/message-queue.js';
import { composePrompt } from '$lib/server/prompt.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const keys = body.keys || 'Escape';
	const rawText: string = typeof body.text === 'string' ? body.text : '';
	const raw = body.raw === true;

	const prompt = composePrompt(target, rawText, body.attachments);
	if (!prompt.ok) return json({ error: prompt.error }, { status: 400 });
	const finalText = prompt.text;

	try {
		if (finalText) {
			sendTextToPane(target, finalText, { appendEnter: !raw });
			if (!raw && !(await confirmSubmitted(target))) {
				return json(
					{ error: 'Claude Code did not take the message; it is still in its input box' },
					{ status: 502 }
				);
			}
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
