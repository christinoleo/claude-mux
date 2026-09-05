import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Browser-side events, written to the server log — see $lib/client-log. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		kind?: string;
		data?: unknown;
		url?: string;
		ua?: string;
		at?: string;
	} | null;
	if (!body || typeof body.kind !== 'string') return json({ ok: false }, { status: 400 });
	const line = `[client:${body.kind}] ${body.at ?? ''} ${body.url ?? ''} ${JSON.stringify(body.data ?? null)} ua=${body.ua ?? ''}`;
	if (body.kind === 'error' || body.kind === 'stale') console.error(line);
	else console.log(line);
	return json({ ok: true });
};
