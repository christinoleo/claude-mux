import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { markDictated, sendTextToPane, submitToPane } from '$shared/server/message-queue.js';
import { composePrompt } from '$lib/server/prompt.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const keys = body.keys || 'Escape';
	const rawText: string = typeof body.text === 'string' ? body.text : '';
	const raw = body.raw === true;

	const prompt = composePrompt(target, rawText, body.attachments);
	if (!prompt.ok) return json({ error: prompt.error }, { status: 400 });

	try {
		if (prompt.text) {
			// Raw text is put in the box on purpose, beside whatever is there.
			if (raw) sendTextToPane(target, prompt.text, { appendEnter: false });
			const result = raw ? 'taken' : await submitToPane(target, prompt.text);
			if (result === 'occupied') {
				return json(
					{ error: "Something else is typed in the pane's prompt box: send or clear it first" },
					{ status: 409 }
				);
			}
			if (result === 'in-box') {
				return json(
					{ error: 'Claude Code did not take the message; it is still in its input box' },
					{ status: 502 }
				);
			}
			if (body.dictated === true) markDictated(target, prompt.text);
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
