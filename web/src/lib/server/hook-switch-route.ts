import { json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { HookWriter } from '$shared/server/hook-switch.js';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { listenPort } from '$lib/server/instance';

interface Switch {
	read(writer: Pick<HookWriter, 'dev'>): { enabled: boolean; switchable: boolean };
	set(enabled: boolean, writer: HookWriter): boolean;
}

/** The routes for this machine's side of a hook switch. Another machine's is reached through the fleet relay. */
export function hookSwitchRoute({ read, set }: Switch): { GET: RequestHandler; POST: RequestHandler } {
	return {
		GET: async () => json(read({ dev })),

		POST: async ({ request }) => {
			// A text/plain POST passes SvelteKit's CSRF check, and this one writes the
			// settings every Claude Code on the machine reads: only this server's own
			// page, or a peer's relay, may ask.
			if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
				return json({ error: 'cross-origin request refused' }, { status: 403 });
			}
			const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
			if (typeof body?.enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, { status: 400 });
			try {
				if (!set(body.enabled, { dev, port: listenPort() })) {
					return json({ error: 'A dev server does not change Claude Code settings' }, { status: 409 });
				}
			} catch (err) {
				return json({ error: `Could not change ~/.claude/settings.json: ${String(err)}` }, { status: 500 });
			}
			return json(read({ dev }));
		}
	};
}
