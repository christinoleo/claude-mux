import type { RequestHandler } from './$types';
import { projectIcon } from '$shared/server/project-icons.js';

/**
 * A project's icon, as this machine read it (`src/server/project-icons.ts`).
 * Only a project this machine reported has one, so `root` can name nothing
 * else on its disk. The page asks with the icon's token in `v`, so a new icon
 * is a new URL and an old one can be kept.
 */
export const GET: RequestHandler = async ({ url }) => {
	const root = url.searchParams.get('root');
	const icon = root ? projectIcon(root) : null;
	if (!icon) return new Response('no icon', { status: 404 });
	return new Response(icon.bytes, {
		headers: {
			'Content-Type': icon.type,
			'Cache-Control': url.searchParams.has('v') ? 'private, max-age=604800, immutable' : 'no-cache',
			// An SVG opened on its own must not run anything as this origin.
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
