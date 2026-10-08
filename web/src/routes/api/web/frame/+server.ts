import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkFraming } from '$shared/server/web-preview.js';

/** Whether the page at `url` lets a page at `origin` frame it, read off its headers. */
export const GET: RequestHandler = async ({ url }) => {
	const target = url.searchParams.get('url');
	const origin = url.searchParams.get('origin');
	if (!target || !origin) return json({ error: 'url and origin are required' }, { status: 400 });
	try {
		const { protocol } = new URL(target);
		if (protocol !== 'http:' && protocol !== 'https:') throw new Error();
		new URL(origin);
	} catch {
		return json({ error: 'url and origin must be http(s) URLs' }, { status: 400 });
	}
	return json(await checkFraming(target, origin));
};
