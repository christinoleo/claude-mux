/**
 * A pull request or issue read whole for the side panel's GitHub pane, and
 * the pull request a branch has, both through `gh` with `execFile` beside the
 * chips' own reader (`github-refs.ts`).
 *
 * One GraphQL read answers the header, body and a pull request's reviews and
 * checks; the comments come from a second, run alongside it. Answers are
 * shared by every page that asks and kept briefly: a minute while the item
 * is open, ten once it is merged or closed. Two asks for one item at once
 * are one read. A refresh that fails, a rate limit included, serves the last
 * good answer marked `stale`. Once an answer has expired, GitHub is first
 * asked through the REST endpoint with the ETag it gave last time: a 304 is
 * free and says nothing changed. That says nothing about checks finishing,
 * so a pull request with checks still running skips it and reads in full.
 */

import { execFile } from 'child_process';
import { homedir } from 'os';
import { isRepoSlug } from '../github-ref.js';
import {
	COMMENTS_QUERY,
	ITEM_QUERY,
	hasRunningChecks,
	isSettled,
	toGithubItem,
	type GithubItem,
	type GithubItemError,
	type RawComments,
	type RawItem
} from '../github-item.js';

/** How long an open item's answer stands. */
export const OPEN_TTL_MS = 60_000;
/** How long a merged or closed one's does: neither changes much. */
export const SETTLED_TTL_MS = 10 * 60_000;
/** A failure GitHub gave no reason for is tried again this soon. */
export const FAILED_TTL_MS = 10_000;
/** With `gh` missing or logged out, nothing is asked for this long. */
const NO_GH_RETRY_MS = 60_000;
const MAX_RUNNING = 4;
const MAX_CACHED = 200;

/** What one `gh` run printed and whether it exited cleanly; `gh api` exits 1 on a 304. */
export interface GhOutput {
	ok: boolean;
	out: string;
	err: string;
	/** `gh` is not installed. */
	missing?: boolean;
}
export type GhCall = (args: string[]) => Promise<GhOutput>;

const callGh: GhCall = (args) =>
	new Promise((resolve) => {
		execFile('gh', args, { cwd: homedir(), timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({
				ok: !err,
				out: String(stdout),
				err: String(stderr),
				missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
			});
		});
	});

export type GithubItemAnswer =
	| { item: GithubItem; stale: boolean; error?: undefined }
	| { item: null; stale?: undefined; error: GithubItemError };

/** What a failed run comes to. */
function failure(res: GhOutput): GithubItemError {
	if (res.missing || /gh auth login|GH_TOKEN|not logged in/i.test(res.err)) return 'no-gh';
	if (/Could not resolve to|HTTP 404/.test(res.err)) return 'not-found';
	return 'failed';
}

/** The status and ETag of a `gh api -i` answer; null when it printed no status line. */
export function readHead(out: string): { status: number; etag: string | null } | null {
	const status = /^HTTP\/[\d.]+ (\d{3})/.exec(out);
	if (!status) return null;
	const head = out.split(/\r?\n\r?\n/, 1)[0];
	const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null;
	return { status: Number(status[1]), etag };
}

function graphql(query: string, repo: string, number: number): string[] {
	const [owner, name] = repo.split('/');
	return ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`];
}

function ttlFor(item: GithubItem): number {
	return isSettled(item) ? SETTLED_TTL_MS : OPEN_TTL_MS;
}

interface Held {
	answer: GithubItemAnswer;
	/** The last item GitHub gave, kept to serve when a refresh fails. */
	good: GithubItem | null;
	etag: string | null;
	until: number;
}

export interface GithubItemReader {
	/** The pull request or issue `number` in `repo`, from the cache while it stands. */
	read(repo: string, number: number): Promise<GithubItemAnswer>;
	/** The newest pull request whose head is `branch`, or null for none. */
	branchPull(repo: string, branch: string): Promise<number | null>;
}

/** A reader with a cache of its own; `gh` and the clock are passed in by the tests. */
export function createGithubItemReader(gh: GhCall = callGh, now: () => number = Date.now): GithubItemReader {
	const cache = new Map<string, Held>();
	const inflight = new Map<string, Promise<GithubItemAnswer>>();
	const pulls = new Map<string, { until: number; number: Promise<number | null> }>();
	let noGhUntil = 0;
	let running = 0;
	const waiting: (() => void)[] = [];

	async function limited(args: string[]): Promise<GhOutput> {
		if (running >= MAX_RUNNING) await new Promise<void>((turn) => waiting.push(turn));
		running++;
		try {
			return await gh(args);
		} finally {
			running--;
			waiting.shift()?.();
		}
	}

	function keep(key: string, held: Held): GithubItemAnswer {
		// Re-inserting moves the key to the end, so the oldest answer is first out.
		cache.delete(key);
		cache.set(key, held);
		if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
		return held.answer;
	}

	/** The last good answer when there is one, else why there is none. */
	function fallBack(key: string, have: Held | undefined, error: GithubItemError): GithubItemAnswer {
		if (error === 'no-gh') noGhUntil = now() + NO_GH_RETRY_MS;
		if (have?.good && error !== 'not-found') {
			return keep(key, { ...have, answer: { item: have.good, stale: true }, until: now() + FAILED_TTL_MS });
		}
		const ttl = error === 'failed' ? FAILED_TTL_MS : OPEN_TTL_MS;
		return keep(key, { answer: { item: null, error }, good: null, etag: null, until: now() + ttl });
	}

	/** Ask the REST endpoint whether anything changed: true for a 304, else the new ETag. */
	async function revalidate(repo: string, number: number, etag: string): Promise<true | string | null> {
		const res = await limited(['api', '-i', '-H', `If-None-Match: ${etag}`, `repos/${repo}/issues/${number}`]);
		const head = readHead(res.out);
		if (head?.status === 304) return true;
		return head?.status === 200 ? head.etag : null;
	}

	async function refresh(key: string, repo: string, number: number): Promise<GithubItemAnswer> {
		const have = cache.get(key);
		let etag = have?.etag ?? null;
		if (have?.good && etag && !hasRunningChecks(have.good)) {
			const fresh = await revalidate(repo, number, etag);
			if (fresh === true) {
				return keep(key, { ...have, answer: { item: have.good, stale: false }, until: now() + ttlFor(have.good) });
			}
			etag = fresh;
		}
		const [main, talk, head] = await Promise.all([
			limited(graphql(ITEM_QUERY, repo, number)),
			limited(graphql(COMMENTS_QUERY, repo, number)),
			// The first read has no ETag yet; this one is what later refreshes revalidate with.
			etag ? Promise.resolve(null) : limited(['api', '-i', `repos/${repo}/issues/${number}`])
		]);
		if (head) etag = readHead(head.out)?.etag ?? null;
		if (!main.ok) return fallBack(key, have, failure(main));
		try {
			const raw = (JSON.parse(main.out) as { data?: { repository?: { issueOrPullRequest?: RawItem | null } } }).data
				?.repository?.issueOrPullRequest;
			if (!raw) return fallBack(key, have, 'not-found');
			let comments: RawComments | null = null;
			if (talk.ok) {
				comments =
					(JSON.parse(talk.out) as { data?: { repository?: { issueOrPullRequest?: RawComments | null } } }).data
						?.repository?.issueOrPullRequest ?? null;
			}
			const item = toGithubItem(raw, repo, comments);
			// A conversation that failed to load keeps the one read last, rather than show none.
			if (!item.comments && have?.good?.comments) {
				item.comments = have.good.comments;
				item.comments_total = have.good.comments_total;
			}
			return keep(key, { answer: { item, stale: false }, good: item, etag, until: now() + ttlFor(item) });
		} catch {
			return fallBack(key, have, 'failed');
		}
	}

	function read(repo: string, number: number): Promise<GithubItemAnswer> {
		if (!isRepoSlug(repo) || !Number.isSafeInteger(number) || number < 1) {
			return Promise.resolve({ item: null, error: 'not-found' });
		}
		const key = `${repo.toLowerCase()}#${number}`;
		const have = cache.get(key);
		if (have && now() < have.until) return Promise.resolve(have.answer);
		if (now() < noGhUntil) {
			return Promise.resolve(have?.good ? { item: have.good, stale: true } : { item: null, error: 'no-gh' });
		}
		let run = inflight.get(key);
		if (!run) {
			run = refresh(key, repo, number).finally(() => inflight.delete(key));
			inflight.set(key, run);
		}
		return run;
	}

	function branchPull(repo: string, branch: string): Promise<number | null> {
		if (!isRepoSlug(repo) || !branch || now() < noGhUntil) return Promise.resolve(null);
		const key = `${repo.toLowerCase()}@${branch}`;
		const have = pulls.get(key);
		if (have && now() < have.until) return have.number;
		const [owner, name] = repo.split('/');
		const query =
			'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){' +
			'pullRequests(headRefName:$branch,first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number}}}}';
		const number = limited(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `branch=${branch}`]).then(
			(res) => {
				if (!res.ok) {
					if (failure(res) === 'no-gh') noGhUntil = now() + NO_GH_RETRY_MS;
					return null;
				}
				try {
					const nodes = (JSON.parse(res.out) as { data?: { repository?: { pullRequests?: { nodes?: { number: number }[] } } } })
						.data?.repository?.pullRequests?.nodes;
					return nodes?.[0]?.number ?? null;
				} catch {
					return null;
				}
			}
		);
		pulls.set(key, { until: now() + OPEN_TTL_MS, number });
		if (pulls.size > MAX_CACHED) pulls.delete(pulls.keys().next().value!);
		return number;
	}

	return { read, branchPull };
}

/** The one reader the routes share, so every page and the chips' hover warm the same cache. */
export const githubItems = createGithubItemReader();
