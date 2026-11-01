import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync } from 'child_process';
import { markDictated, paneHasDialog, submitToPane, typeIntoPane } from '$shared/server/message-queue.js';
import { composePrompt, REFUSALS } from '$lib/server/prompt.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const keys = body.keys || 'Escape';
	const rawText: string = typeof body.text === 'string' ? body.text : '';
	const raw = body.raw === true;
	// A dialog's own text field and the sign-in's code field are typed into on purpose.
	const answering = body.answering === true;

	const prompt = composePrompt(target, rawText, body.attachments);
	if (!prompt.ok) return json({ error: prompt.error }, { status: 400 });

	try {
		if (prompt.text) {
			const result = raw
				? await typeIntoPane(target, prompt.text, { answering })
				: await submitToPane(target, prompt.text);
			if (result !== 'taken') {
				const { error, status } = REFUSALS[result];
				return json({ error }, { status });
			}
			if (body.dictated === true) markDictated(target, prompt.text);
		} else {
			// The Enter that follows a raw send, which a dialog opened since would take.
			if (body.unlessDialog === true && (await paneHasDialog(target))) {
				const { error, status } = REFUSALS.dialog;
				return json({ error }, { status });
			}
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
