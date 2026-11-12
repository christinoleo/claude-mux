import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { paneForTarget } from '$lib/server/prompt.js';
import { shellLoginToLogin, tmuxPane } from '$shared/server/shell-login.js';

/** Panes being switched, so a second tap waits its turn rather than typing into the first. */
const busy = new Set<string>();

/**
 * Stop the `! claude auth login` running in the pane, whose code field no keys
 * reach, and run `/login` in its place, which the sign-in card can type into.
 */
export const POST: RequestHandler = async ({ params }) => {
	const { pane } = paneForTarget(decodeURIComponent(params.id));
	if (busy.has(pane)) return json({ error: 'Already switching this pane to /login' }, { status: 409 });
	busy.add(pane);
	try {
		const result = await shellLoginToLogin(tmuxPane(pane));
		return result.ok ? json(result) : json(result, { status: 409 });
	} catch {
		return json({ error: 'Could not reach the pane' }, { status: 500 });
	} finally {
		busy.delete(pane);
	}
};
