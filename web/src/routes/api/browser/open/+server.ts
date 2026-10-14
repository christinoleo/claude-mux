import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openableUrl, openTab } from '$shared/server/browser-view.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';

/**
 * Show a github.com pull request or issue in the remote browser, in a tab
 * opened in the background (or the one opened for it before), and answer
 * that tab's id for the Web pane's Browser source to pin.
 */
export const POST: RequestHandler = async ({ request }) => {
	// This opens a page in a logged-in browser: only this server's own page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
	const url = openableUrl(body?.url);
	if (!url) return json({ error: 'Only a GitHub pull request or issue can be opened.' }, { status: 400 });
	const opened = await openTab(url);
	return json(opened, { status: 'tab' in opened ? 200 : 502 });
};
