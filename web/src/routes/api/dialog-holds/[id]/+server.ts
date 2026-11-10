import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { dialogHolds } from '$shared/server/dialog-holds.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';

const AnswerSchema = z.discriminatedUnion('decision', [
	z.object({
		decision: z.literal('allow'),
		answers: z.record(z.string(), z.string()).optional(),
		annotations: z.record(z.string(), z.object({ notes: z.string() })).optional()
	}),
	z.object({ decision: z.literal('deny'), message: z.string().optional() })
]);

/** A person's press on a dialog's card, which names the hold they were looking at. */
export const POST: RequestHandler = async ({ params, request }) => {
	// A text/plain POST passes SvelteKit's CSRF check, and this one can run a command.
	// A page always sends an Origin, and the relay puts one on what it forwards.
	const origin = request.headers.get('origin');
	if (!origin || !pageOriginAllowed(origin, request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const answer = AnswerSchema.safeParse(await request.json().catch(() => null));
	if (!answer.success) return json({ error: 'Not an answer' }, { status: 400 });

	switch (dialogHolds.answer(params.id, answer.data)) {
		case 'answered':
			return json({ ok: true });
		case 'incomplete':
			return json({ error: 'Every question needs an answer' }, { status: 400 });
		case 'gone':
			return json({ error: 'This dialog has already ended' }, { status: 409 });
	}
};
