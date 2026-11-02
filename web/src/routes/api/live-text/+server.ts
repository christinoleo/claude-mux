import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { readLiveText, setLiveText } from '$shared/server/live-text-switch.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { listenPort } from '$lib/server/instance';

/** This machine's live text switch. Another machine's is reached through the fleet relay. */
export const GET: RequestHandler = async () => json(readLiveText({ dev }));

export const POST: RequestHandler = async ({ request }) => {
	// A text/plain POST passes SvelteKit's CSRF check, and this one writes the
	// settings every Claude Code on the machine reads: only this server's own
	// page, or a peer's relay, may ask.
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
	if (typeof body?.enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, { status: 400 });
	try {
		if (!setLiveText(body.enabled, { dev, port: listenPort() })) {
			return json({ error: 'A dev server does not change Claude Code settings' }, { status: 409 });
		}
	} catch (err) {
		return json({ error: `Could not change ~/.claude/settings.json: ${String(err)}` }, { status: 500 });
	}
	return json(readLiveText({ dev }));
};
