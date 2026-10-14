/**
 * Images and videos in a pull request or issue, fetched for the GitHub pane
 * with `gh`'s token. A private repo's attachments answer a browser with no
 * GitHub session with a 404, so the pane asks this server instead. The token
 * goes only to GitHub's own hosts: an attachment answers with a redirect to a
 * signed URL on a storage host, which is followed without it.
 */

import { execFile } from 'child_process';
import { homedir } from 'os';

/** Hosts whose files a pull request or issue body points at. */
const MEDIA_HOSTS = new Set([
	'github.com',
	'raw.githubusercontent.com',
	'user-images.githubusercontent.com',
	'private-user-images.githubusercontent.com',
	'media.githubusercontent.com',
	'objects.githubusercontent.com'
]);
/** The hosts the token may be sent to. */
const TOKEN_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'media.githubusercontent.com']);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TOKEN_TTL_MS = 5 * 60_000;

/**
 * Whether `url` is a file the pane may fetch through this server: an
 * attachment (`github.com/user-attachments/…`, `github.com/<o>/<r>/assets/…`,
 * `…/raw/…`, `…/blob/…?raw=true`) or a file on one of GitHub's content hosts.
 */
export function isGithubMediaUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:' || !MEDIA_HOSTS.has(u.hostname) || u.username || u.password || u.port) return false;
	if (u.hostname !== 'github.com') return true;
	return /^\/(user-attachments\/(assets|files)\/|[^/]+\/[^/]+\/(assets|raw|blob|files)\/)/.test(u.pathname);
}

let token: { value: string | null; until: number } | null = null;

function ghToken(): Promise<string | null> {
	if (token && Date.now() < token.until) return Promise.resolve(token.value);
	return new Promise((resolve) => {
		execFile('gh', ['auth', 'token'], { cwd: homedir(), timeout: 5_000 }, (err, stdout) => {
			const value = err ? null : String(stdout).trim() || null;
			token = { value, until: Date.now() + TOKEN_TTL_MS };
			resolve(value);
		});
	});
}

/** What may be served back: pictures and videos, nothing a page would run. */
function servable(type: string | null): boolean {
	return !!type && /^(image|video)\//.test(type);
}

/** The file at `url` as a response the route can return, or null when it is not one this serves. */
export async function fetchGithubMedia(url: string): Promise<Response | null> {
	if (!isGithubMediaUrl(url)) return null;
	const auth = await ghToken();
	let at = new URL(url);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const headers: Record<string, string> = { 'user-agent': 'claude-mux' };
		if (auth && TOKEN_HOSTS.has(at.hostname)) headers.authorization = `token ${auth}`;
		const res = await fetch(at, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
		const next = res.headers.get('location');
		if (res.status >= 300 && res.status < 400 && next) {
			at = new URL(next, at);
			// A redirect may only lead to https; the token is never sent past GitHub's own hosts.
			if (at.protocol !== 'https:') return null;
			continue;
		}
		if (!res.ok) return new Response(null, { status: res.status === 404 ? 404 : 502 });
		const type = res.headers.get('content-type');
		const size = Number(res.headers.get('content-length') ?? 0);
		if (!servable(type) || size > MAX_BYTES) {
			await res.body?.cancel();
			return new Response(null, { status: 415 });
		}
		return new Response(res.body, {
			headers: {
				'content-type': type!,
				...(size ? { 'content-length': String(size) } : {}),
				'cache-control': 'private, max-age=3600',
				// An SVG is an image here and a document if opened on its own: it runs nothing either way.
				'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
				'x-content-type-options': 'nosniff'
			}
		});
	}
	return null;
}
