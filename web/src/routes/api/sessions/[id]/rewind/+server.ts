import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { paneForTarget } from '$lib/server/prompt.js';
import { chooseRewind, closeRewind, openRewindAt } from '$shared/server/rewind.js';
import { REWIND_CHOICES, type RewindChoice } from '$shared/tmux/rewind.js';

/** Panes a rewind is being worked in, so a second click waits its turn rather than typing into the first. */
const busy = new Set<string>();

/**
 * Work Claude Code's rewind dialog in the pane.
 *
 * - `{ action: 'open', prompt, back }` opens the confirmation for going back
 *   to before `prompt`, `back` rows above "(current)" (null: from wherever the
 *   open list's selection stands). Only on an idle pane: Esc Esc would stop a
 *   running turn, and in a dialog the keys land in the dialog.
 * - `{ action: 'choose', choice }` picks a choice in the open confirmation.
 * - `{ action: 'cancel' }` closes the dialog.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { pane, state } = paneForTarget(decodeURIComponent(params.id));
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const action = body?.action;
	if (action === 'open' && state !== 'idle') {
		return json({ error: 'Stop the turn first' }, { status: 409 });
	}
	if (busy.has(pane)) return json({ error: 'A rewind is already being worked in this pane' }, { status: 409 });
	busy.add(pane);
	try {
		if (action === 'open') {
			const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
			const back = typeof body?.back === 'number' && Number.isInteger(body.back) ? body.back : null;
			if (!prompt.trim()) return json({ error: 'No prompt named' }, { status: 400 });
			if (back !== null && (back < 1 || back > 500)) return json({ error: 'Bad position' }, { status: 400 });
			const result = await openRewindAt(pane, prompt, back);
			return result.ok ? json(result) : json(result, { status: 409 });
		}
		if (action === 'choose') {
			const choice = body?.choice;
			if (!REWIND_CHOICES.includes(choice as RewindChoice)) {
				return json({ error: 'Unknown choice' }, { status: 400 });
			}
			const result = await chooseRewind(pane, choice as RewindChoice);
			return result.ok ? json(result) : json(result, { status: 409 });
		}
		if (action === 'cancel') {
			return (await closeRewind(pane)) ? json({ ok: true }) : json({ error: 'The dialog would not close' }, { status: 409 });
		}
		return json({ error: 'Unknown action' }, { status: 400 });
	} catch {
		return json({ error: 'Failed to reach the pane' }, { status: 500 });
	} finally {
		busy.delete(pane);
	}
};
