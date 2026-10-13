/**
 * One pull request or issue, read for the chip the transcript draws over a
 * link to it. Read through `gh` like the rest of what GitHub tells us
 * (`github.ts`), on request and cached briefly. Anything that cannot be read —
 * `gh` missing or logged out, a repo that is private to someone else, a
 * number nobody filed — is null, and the link stays a plain link.
 */

import { execFile } from 'child_process';
import { homedir } from 'os';
import { isRepoSlug, type GithubRef } from '../github-ref.js';

/** How long an answer, found or not, stands before GitHub is asked again. */
const TTL_MS = 60_000;
/** A read that failed for no reason GitHub gave (a timeout, a rate limit) is tried again this soon. */
const FAILED_TTL_MS = 10_000;
/** How many `gh` processes run at once; a message can name dozens of issues. */
const MAX_RUNNING = 4;
/** With `gh` missing or logged out, nothing is asked for this long. */
const NO_GH_RETRY_MS = 60_000;
const MAX_CACHED = 500;

/** The slice of GitHub's REST issue object a chip is made of; pull requests share the endpoint. */
export interface RawRef {
	number: number;
	title: string;
	state: string;
	html_url: string;
	updated_at?: string | null;
	draft?: boolean | null;
	user?: { login?: string } | null;
	pull_request?: { merged_at?: string | null } | null;
}

export function toGithubRef(raw: RawRef, repo: string): GithubRef {
	const pull = raw.pull_request ?? null;
	const draft = raw.draft === true;
	const open = raw.state !== 'closed';
	const updated = raw.updated_at ? Date.parse(raw.updated_at) : NaN;
	return {
		repo,
		number: raw.number,
		kind: pull ? 'pull' : 'issue',
		title: raw.title,
		state: pull?.merged_at ? 'merged' : !open ? 'closed' : draft ? 'draft' : 'open',
		draft,
		author: raw.user?.login ?? null,
		updated_at: Number.isNaN(updated) ? null : updated,
		url: raw.html_url
	};
}

/** What one `gh` run came to: its output, or why there is none. */
export type GhResult = { out: string } | { failed: 'no-gh' | 'not-found' | 'other' };
export type GhRunner = (args: string[]) => Promise<GhResult>;

const runGh: GhRunner = (args) =>
	new Promise((resolve) => {
		// `gh api` needs no checkout; the home directory keeps it out of any repo's config.
		execFile('gh', args, { cwd: homedir(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (!err) return resolve({ out: stdout });
			const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
			const said = String(stderr);
			if (missing || /gh auth login|GH_TOKEN/.test(said)) resolve({ failed: 'no-gh' });
			else resolve({ failed: /HTTP 404/.test(said) ? 'not-found' : 'other' });
		});
	});

/** The pull request or issue `number` in `repo`, or null when it cannot be read. */
export type GithubRefReader = (repo: string, number: number) => Promise<GithubRef | null>;

/** A reader with a cache of its own; `gh` and the clock are passed in by the tests. */
export function createGithubRefReader(gh: GhRunner = runGh, now: () => number = Date.now): GithubRefReader {
	const cache = new Map<string, { until: number; ref: GithubRef | null }>();
	const inflight = new Map<string, Promise<GithubRef | null>>();
	let noGhUntil = 0;
	let running = 0;
	const waiting: (() => void)[] = [];

	/** Run `gh`, waiting for a turn while `MAX_RUNNING` others are out. */
	async function limited(args: string[]): Promise<GhResult> {
		if (running >= MAX_RUNNING) await new Promise<void>((turn) => waiting.push(turn));
		running++;
		try {
			return await gh(args);
		} finally {
			running--;
			waiting.shift()?.();
		}
	}

	/** The answer, and how long it stands: GitHub's word for a minute, a failure it did not explain for less. */
	async function fetchRef(repo: string, number: number): Promise<{ ref: GithubRef | null; ttl: number }> {
		const res = await limited(['api', `repos/${repo}/issues/${number}`]);
		if ('failed' in res) {
			if (res.failed === 'no-gh') noGhUntil = now() + NO_GH_RETRY_MS;
			return { ref: null, ttl: res.failed === 'not-found' ? TTL_MS : FAILED_TTL_MS };
		}
		try {
			return { ref: toGithubRef(JSON.parse(res.out) as RawRef, repo), ttl: TTL_MS };
		} catch {
			return { ref: null, ttl: FAILED_TTL_MS };
		}
	}

	return (repo, number) => {
		if (!isRepoSlug(repo) || !Number.isSafeInteger(number) || number < 1) return Promise.resolve(null);
		const key = `${repo.toLowerCase()}#${number}`;
		const have = cache.get(key);
		if (have && now() < have.until) return Promise.resolve(have.ref);
		if (now() < noGhUntil) return Promise.resolve(null);
		let run = inflight.get(key);
		if (!run) {
			run = fetchRef(repo, number).then(({ ref, ttl }) => {
				inflight.delete(key);
				// Re-inserting moves the key to the end, so the oldest answer is first out.
				cache.delete(key);
				cache.set(key, { until: now() + ttl, ref });
				if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
				return ref;
			});
			inflight.set(key, run);
		}
		return run;
	};
}

/** The pull request or issue `number` in `repo`, as GitHub last said; null when it cannot be read. */
export const readGithubRef = createGithubRefReader();
