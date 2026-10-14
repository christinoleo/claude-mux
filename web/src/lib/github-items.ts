/**
 * The browser's side of the GitHub pane's reads: one pull request or issue
 * whole, kept here a minute so a second open (or the click after a chip's
 * hover card) paints at once, and the session's own defaults. Every read
 * goes to the session's machine (`base`), whose `gh` is the one that knows
 * its repos.
 */

import type { GithubItem, GithubItemError } from '$shared/github-item.js';

/** How long an answer is drawn from here without asking again. */
const TTL_MS = 60_000;
const MAX_KEPT = 60;

export type GithubItemResult =
	| { item: GithubItem; stale: boolean; error?: undefined }
	| { item: null; stale?: undefined; error: GithubItemError | 'unreachable' };

interface Kept {
	at: number;
	result: Promise<GithubItemResult>;
	/** The answer once it came, for a paint that cannot wait. */
	settled: GithubItemResult | null;
}

const kept = new Map<string, Kept>();

function key(base: string, repo: string, number: number): string {
	return `${base}|${repo.toLowerCase()}#${number}`;
}

async function fetchItem(base: string, repo: string, number: number): Promise<GithubItemResult> {
	try {
		const params = new URLSearchParams({ repo, number: String(number) });
		const res = await fetch(`${base}/api/github/item?${params}`);
		if (!res.ok) return { item: null, error: res.status === 404 ? 'not-found' : 'unreachable' };
		return (await res.json()) as GithubItemResult;
	} catch {
		return { item: null, error: 'unreachable' };
	}
}

/** The last answer for a pull request or issue, if one is here at all, however old. */
export function peekGithubItem(base: string, repo: string, number: number): GithubItemResult | null {
	return kept.get(key(base, repo, number))?.settled ?? null;
}

/** A pull request or issue, from here while the answer is young, else from the server. */
export function loadGithubItem(base: string, repo: string, number: number, fresh = false): Promise<GithubItemResult> {
	const k = key(base, repo, number);
	const have = kept.get(k);
	if (have && !fresh && Date.now() - have.at < TTL_MS) return have.result;
	const entry: Kept = { at: Date.now(), result: fetchItem(base, repo, number), settled: have?.settled ?? null };
	void entry.result.then((r) => {
		// A failure keeps the last good answer to paint, and is asked again next time.
		if (r.item || !entry.settled?.item) entry.settled = r;
		if (!r.item) entry.at = 0;
	});
	kept.delete(k);
	kept.set(k, entry);
	if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
	return entry.result;
}

/** What the pane shows for a session before anything is picked. */
export interface SessionGithub {
	repo: string | null;
	pull: number | null;
	issue: number | null;
}

export async function loadSessionGithub(api: string): Promise<SessionGithub | null> {
	try {
		const res = await fetch(`${api}/github`);
		return res.ok ? ((await res.json()) as SessionGithub) : null;
	} catch {
		return null;
	}
}

/** GitHub's hosts that may hold a private repo's files; camo and the rest are public. */
const PROXIED = new Set([
	'github.com',
	'raw.githubusercontent.com',
	'user-images.githubusercontent.com',
	'private-user-images.githubusercontent.com',
	'media.githubusercontent.com',
	'objects.githubusercontent.com'
]);

/** Where a body's image is drawn from: GitHub's own files through the session's machine, others as written. */
export function mediaHref(base: string): (url: string) => string | null {
	return (url) => {
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return null;
		}
		return PROXIED.has(host) ? `${base}/api/github/media?${new URLSearchParams({ url })}` : url;
	};
}
