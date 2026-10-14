/**
 * A pull request or issue as the side panel's GitHub pane draws it, and the
 * reading of GitHub's GraphQL answer into that shape. Shared by the server,
 * which reads GitHub through `gh`, and the pane, which groups and words what
 * it is sent. Nothing here touches the network or the clock.
 */

import { isRepoSlug, parseRefNumber, type GithubRefKind, type GithubRefState } from './github-ref.js';

export interface GithubLabel {
	name: string;
	/** GitHub's colour for it, six hex digits with no `#`. */
	color: string;
}

/** A reviewer's latest word on a pull request. */
export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface GithubReview {
	author: string;
	verdict: ReviewVerdict;
	at: number | null;
	/** Given before the newest commit, so it may no longer hold. */
	stale: boolean;
}

/** Where a check stands, in the order the pane lists them: what wants attention first. */
export type CheckBucket = 'failing' | 'running' | 'passing';

export interface GithubCheck {
	name: string;
	bucket: CheckBucket;
	/** GitHub's own word for how it ended or where it is, lower case. */
	status: string;
	url: string | null;
}

export interface GithubComment {
	id: string;
	author: string;
	/** Written by an app rather than a person. */
	bot: boolean;
	body: string;
	at: number | null;
	url: string;
}

export interface GithubPullFacts {
	base: string;
	head: string;
	additions: number;
	deletions: number;
	files: number;
	/** One per reviewer, the latest. */
	reviews: GithubReview[];
	/** Reviewers asked for and not yet heard from: logins, or team names. */
	requested: string[];
	checks: GithubCheck[];
}

export interface GithubItem {
	repo: string;
	number: number;
	kind: GithubRefKind;
	title: string;
	state: GithubRefState;
	url: string;
	body: string;
	author: string | null;
	created_at: number | null;
	updated_at: number | null;
	labels: GithubLabel[];
	/** Only for a pull request. */
	pull: GithubPullFacts | null;
	/** Newest last; null when the second read failed. */
	comments: GithubComment[] | null;
	/** How many comments GitHub holds, which may be more than were read. */
	comments_total: number;
}

/** Why there is no item to show: `gh` missing or logged out, no such item, or GitHub did not answer. */
export type GithubItemError = 'no-gh' | 'not-found' | 'failed';

// ── GitHub's answer ──────────────────────────────────────────────────────

/** Asked once per pane for the header, body and the pull request's facts. */
export const ITEM_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){
__typename
... on Issue{number title url body state createdAt updatedAt author{login} labels(first:20){nodes{name color}}}
... on PullRequest{number title url body state isDraft additions deletions changedFiles createdAt updatedAt headRefName baseRefName author{login} labels(first:20){nodes{name color}}
latestReviews(first:30){nodes{state submittedAt author{login}}}
reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Bot{login} ... on Team{name} ... on Mannequin{login}}}}
commits(last:1){nodes{commit{committedDate statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}
}}}`;

/** How many comments the second read takes, newest. */
export const COMMENTS_READ = 100;

/** Asked beside `ITEM_QUERY`, in parallel: the conversation. */
export const COMMENTS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){
... on Issue{comments(last:${COMMENTS_READ}){totalCount nodes{id body createdAt url isMinimized author{__typename login}}}}
... on PullRequest{comments(last:${COMMENTS_READ}){totalCount nodes{id body createdAt url isMinimized author{__typename login}}}}
}}}`;

interface RawActor {
	__typename?: string;
	login?: string;
	name?: string;
}

interface RawContext {
	__typename?: string;
	name?: string;
	status?: string;
	conclusion?: string | null;
	detailsUrl?: string | null;
	context?: string;
	state?: string;
	targetUrl?: string | null;
}

/** The slice of `issueOrPullRequest` that `ITEM_QUERY` asks for. */
export interface RawItem {
	__typename: 'Issue' | 'PullRequest';
	number: number;
	title: string;
	url: string;
	body?: string | null;
	state: string;
	isDraft?: boolean;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	createdAt?: string | null;
	updatedAt?: string | null;
	headRefName?: string;
	baseRefName?: string;
	author?: RawActor | null;
	labels?: { nodes?: (GithubLabel | null)[] } | null;
	latestReviews?: { nodes?: ({ state: string; submittedAt?: string | null; author?: RawActor | null } | null)[] } | null;
	reviewRequests?: { nodes?: ({ requestedReviewer?: RawActor | null } | null)[] } | null;
	commits?: {
		nodes?: ({
			commit?: { committedDate?: string | null; statusCheckRollup?: { contexts?: { nodes?: (RawContext | null)[] } } | null };
		} | null)[];
	} | null;
}

export interface RawComment {
	id: string;
	body?: string | null;
	createdAt?: string | null;
	url: string;
	isMinimized?: boolean;
	author?: RawActor | null;
}

export interface RawComments {
	comments?: { totalCount?: number; nodes?: (RawComment | null)[] } | null;
}

function time(text: string | null | undefined): number | null {
	if (!text) return null;
	const at = Date.parse(text);
	return Number.isNaN(at) ? null : at;
}

function present<T>(list: (T | null | undefined)[] | null | undefined): T[] {
	return (list ?? []).filter((x): x is T => x != null);
}

/** GitHub names a deleted account nothing; it shows it as "ghost". */
function login(actor: RawActor | null | undefined): string {
	return actor?.login ?? actor?.name ?? 'ghost';
}

/** Whether an author is an app: GitHub says so, or its login ends `[bot]`. */
export function isBot(actor: RawActor | null | undefined): boolean {
	return actor?.__typename === 'Bot' || /\[bot\]$/.test(actor?.login ?? '');
}

const VERDICTS: Record<string, ReviewVerdict> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes_requested',
	COMMENTED: 'commented',
	DISMISSED: 'dismissed'
};

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** Where one check of the rollup stands. A check run still going has no conclusion yet. */
export function toCheck(raw: RawContext): GithubCheck | null {
	if (raw.__typename === 'CheckRun') {
		const done = raw.status === 'COMPLETED';
		const word = done ? (raw.conclusion ?? 'COMPLETED') : (raw.status ?? 'PENDING');
		const bucket: CheckBucket = !done ? 'running' : FAILING.has(word) ? 'failing' : 'passing';
		return { name: raw.name ?? 'check', bucket, status: word.toLowerCase().replaceAll('_', ' '), url: raw.detailsUrl ?? null };
	}
	if (raw.__typename === 'StatusContext') {
		const word = raw.state ?? 'PENDING';
		const bucket: CheckBucket = FAILING.has(word) ? 'failing' : word === 'SUCCESS' ? 'passing' : 'running';
		return { name: raw.context ?? 'status', bucket, status: word.toLowerCase(), url: raw.targetUrl ?? null };
	}
	return null;
}

function itemState(raw: RawItem): GithubRefState {
	if (raw.state === 'MERGED') return 'merged';
	if (raw.state === 'CLOSED') return 'closed';
	return raw.isDraft ? 'draft' : 'open';
}

function toPull(raw: RawItem): GithubPullFacts {
	const head = present(raw.commits?.nodes)[0]?.commit;
	const headAt = time(head?.committedDate);
	const reviews = present(raw.latestReviews?.nodes)
		.filter((r) => r.state in VERDICTS)
		.map((r): GithubReview => {
			const at = time(r.submittedAt);
			return { author: login(r.author), verdict: VERDICTS[r.state], at, stale: at !== null && headAt !== null && at < headAt };
		})
		// A dismissal takes the verdict back, so it says nothing about where the pull request stands.
		.filter((r) => r.verdict !== 'dismissed');
	const reviewed = new Set(reviews.map((r) => r.author.toLowerCase()));
	const requested = present(raw.reviewRequests?.nodes)
		.map((r) => (r.requestedReviewer ? login(r.requestedReviewer) : null))
		.filter((name): name is string => name !== null && !reviewed.has(name.toLowerCase()));
	const checks = present(head?.statusCheckRollup?.contexts?.nodes)
		.map(toCheck)
		.filter((c): c is GithubCheck => c !== null);
	return {
		base: raw.baseRefName ?? '',
		head: raw.headRefName ?? '',
		additions: raw.additions ?? 0,
		deletions: raw.deletions ?? 0,
		files: raw.changedFiles ?? 0,
		reviews,
		requested,
		checks
	};
}

export function toComments(raw: RawComments | null | undefined): { comments: GithubComment[]; total: number } | null {
	if (!raw?.comments) return null;
	const comments = present(raw.comments.nodes)
		.filter((c) => !c.isMinimized)
		.map(
			(c): GithubComment => ({
				id: c.id,
				author: login(c.author),
				bot: isBot(c.author),
				body: c.body ?? '',
				at: time(c.createdAt),
				url: c.url
			})
		);
	return { comments, total: raw.comments.totalCount ?? comments.length };
}

/** GitHub's two answers as the pane draws them. */
export function toGithubItem(raw: RawItem, repo: string, comments: RawComments | null): GithubItem {
	const conversation = toComments(comments);
	return {
		repo,
		number: raw.number,
		kind: raw.__typename === 'PullRequest' ? 'pull' : 'issue',
		title: raw.title,
		state: itemState(raw),
		url: raw.url,
		body: raw.body ?? '',
		author: raw.author ? login(raw.author) : null,
		created_at: time(raw.createdAt),
		updated_at: time(raw.updatedAt),
		labels: present(raw.labels?.nodes),
		pull: raw.__typename === 'PullRequest' ? toPull(raw) : null,
		comments: conversation?.comments ?? null,
		comments_total: conversation?.total ?? 0
	};
}

// ── what the pane makes of it ────────────────────────────────────────────

/** Whether nothing more can happen to it soon: merged, or closed. Cached longer. */
export function isSettled(item: Pick<GithubItem, 'state'>): boolean {
	return item.state === 'merged' || item.state === 'closed';
}

/** Whether any check is still going; while one is, GitHub's ETag cannot tell the pane it finished. */
export function hasRunningChecks(item: Pick<GithubItem, 'pull'>): boolean {
	return item.pull?.checks.some((c) => c.bucket === 'running') ?? false;
}

/** The checks in reading order: failing, then running, then passing. */
export function groupChecks(checks: GithubCheck[]): Record<CheckBucket, GithubCheck[]> {
	const out: Record<CheckBucket, GithubCheck[]> = { failing: [], running: [], passing: [] };
	for (const c of checks) out[c.bucket].push(c);
	return out;
}

/** The checks in one line: "7 of 16 running · 1 failed", or "All 12 passed". */
export function describeChecks(checks: GithubCheck[]): string {
	if (checks.length === 0) return 'No checks';
	const { failing, running, passing } = groupChecks(checks);
	if (failing.length === 0 && running.length === 0) {
		return passing.length === 1 ? '1 passed' : `All ${passing.length} passed`;
	}
	const parts: string[] = [];
	if (running.length) parts.push(`${running.length} of ${checks.length} running`);
	if (failing.length) parts.push(`${failing.length} failed`);
	if (!running.length) parts.push(`${passing.length} of ${checks.length} passed`);
	return parts.join(' · ');
}

/**
 * A body with the HTML comments taken out, or '' when that leaves nothing:
 * review bots keep their bookkeeping in `<!-- -->` markers, which would
 * otherwise draw as an empty comment.
 */
export function visibleBody(body: string): string {
	return body.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim() === '' ? '' : body;
}

/** The comments worth a row, and how many bots wrote apart from them. */
export function readableComments(comments: GithubComment[]): { people: GithubComment[]; bots: GithubComment[] } {
	const said = comments.filter((c) => visibleBody(c.body) !== '');
	return { people: said.filter((c) => !c.bot), bots: said.filter((c) => c.bot) };
}

/** A pull request or issue as the pane's `ref` param spells it: `owner/name#n`. */
export function refParam(repo: string, number: number): string {
	return `${repo}#${number}`;
}

/** The pull request or issue a `ref` param names, or null for anything else. */
export function parseRefParam(text: string | null | undefined): { repo: string; number: number } | null {
	const at = text?.lastIndexOf('#') ?? -1;
	if (!text || at < 0) return null;
	const repo = text.slice(0, at);
	const number = parseRefNumber(text.slice(at + 1));
	return number !== null && isRepoSlug(repo) ? { repo, number } : null;
}
