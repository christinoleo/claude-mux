import type { RequestHandler } from './$types';
import { fetchGithubMedia } from '$shared/server/github-media.js';

/**
 * An image or video from a pull request or issue, fetched with `gh`'s token
 * so a private repo's attachments draw in the GitHub pane: `?url=<https url
 * on one of GitHub's hosts>`. Anything else, or anything that is not a
 * picture or a video, is refused.
 */
export const GET: RequestHandler = async ({ url }) => {
	const target = url.searchParams.get('url') ?? '';
	try {
		return (await fetchGithubMedia(target)) ?? new Response('Not a GitHub attachment', { status: 400 });
	} catch {
		return new Response(null, { status: 502 });
	}
};
