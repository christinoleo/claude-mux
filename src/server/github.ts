/**
 * What GitHub says about the work the sessions on this machine are doing.
 *
 * Two skills keep their state on GitHub rather than in any terminal. The
 * maestro daemon hands each worker one issue and tracks it with labels
 * (`in-progress`, `needs-help`), and wayfinder charts a map of decision
 * tickets (`wayfinder:grilling`, `wayfinder:prototype`, …) that a person has
 * to sit down and resolve. Both are questions a person answers, so both
 * belong next to the sessions that are waiting for one.
 *
 * Everything here is read through the `gh` CLI, in the repo's own checkout,
 * so it rides whatever auth the user already has and does nothing where `gh`
 * is missing or logged out. Reads are asynchronous and cached: the session
 * poll runs every 500 ms and only ever sees the last answer, while each repo
 * is re-read at most once a minute in the background.
 */

import { execFile } from 'child_process';
import type { InboxTicket, IssueInfo } from '../types/ws-messages.js';

/** How long an answer from GitHub stands before it is read again. */
const REFRESH_MS = 60_000;
/** A repo `gh` could not name is asked again only this often. */
const NO_REPO_RETRY_MS = 10 * 60_000;
/** A repo no session has pointed at for this long stops being polled. */
const FORGET_MS = 10 * 60_000;

/** The labels whose open, unclaimed, unblocked tickets want a person. */
const HITL_LABELS: Record<string, InboxTicket['kind']> = {
	'wayfinder:grilling': 'grilling',
	'wayfinder:prototype': 'prototype'
};
const NEEDS_HELP = 'needs-help';

/** The slice of GitHub's REST issue object this module reads. */
export interface RawIssue {
	number: number;
	title: string;
	state: string;
	html_url: string;
	created_at: string;
	updated_at: string;
	labels: ({ name?: string } | string)[];
	assignees?: unknown[] | null;
	pull_request?: unknown;
	issue_dependencies_summary?: { blocked_by?: number } | null;
}

interface RepoState {
	gitRoot: string;
	/** `owner/name`, or null when `gh` could not tell. */
	slug: string | null;
	slugTriedAt: number;
	issues: Map<number, IssueInfo>;
	tickets: InboxTicket[];
	/** needs-help comment bodies, keyed by `number@updated_at`. */
	notes: Map<string, string | null>;
	/** Issues the sessions in this repo are working. */
	wanted: Set<number>;
	fetchedAt: number;
	seenAt: number;
	inflight: boolean;
}

const repos = new Map<string, RepoState>();

function gh(args: string[], cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile('gh', args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
			resolve(err ? null : stdout)
		);
	});
}

async function ghJson<T>(args: string[], cwd: string): Promise<T | null> {
	const out = await gh(args, cwd);
	if (out === null) return null;
	try {
		return JSON.parse(out) as T;
	} catch {
		return null;
	}
}

function labelNames(issue: RawIssue): string[] {
	return issue.labels
		.map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
		.filter((name) => name.length > 0);
}

export function toIssueInfo(issue: RawIssue): IssueInfo {
	return {
		number: issue.number,
		title: issue.title,
		state: issue.state === 'closed' ? 'closed' : 'open',
		labels: labelNames(issue),
		url: issue.html_url
	};
}

/**
 * The tickets in a repo's open issues that are waiting on a person: a maestro
 * worker's call for a decision, and the wayfinder tickets on the frontier
 * that only a live conversation resolves — open, nobody's claim, and no open
 * blocker. Pull requests share the endpoint and are skipped.
 */
export function ticketsFromIssues(issues: RawIssue[], slug: string, gitRoot: string): InboxTicket[] {
	const out: InboxTicket[] = [];
	for (const issue of issues) {
		if (issue.pull_request || issue.state !== 'open') continue;
		const labels = labelNames(issue);
		const base = { repo: slug, git_root: gitRoot, number: issue.number, title: issue.title, url: issue.html_url };
		if (labels.includes(NEEDS_HELP)) {
			out.push({ ...base, kind: 'needs-help', since: Date.parse(issue.updated_at), note: null });
			continue;
		}
		const kind = labels.map((l) => HITL_LABELS[l]).find(Boolean);
		if (!kind) continue;
		if ((issue.assignees?.length ?? 0) > 0) continue;
		if ((issue.issue_dependencies_summary?.blocked_by ?? 0) > 0) continue;
		out.push({ ...base, kind, since: Date.parse(issue.created_at), note: null });
	}
	return out;
}

/** The first paragraph of a comment, flattened to one line for a list row. */
export function firstParagraph(body: string): string {
	const para = body.trim().split(/\n\s*\n/)[0] ?? '';
	return para.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function refresh(repo: RepoState): Promise<void> {
	const now = Date.now();
	if (repo.slug === null) {
		if (now - repo.slugTriedAt < NO_REPO_RETRY_MS) return;
		repo.slugTriedAt = now;
		const out = await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], repo.gitRoot);
		repo.slug = out?.trim() || null;
		if (repo.slug === null) return;
	}
	const slug = repo.slug;

	// One page of open issues covers the inbox and, usually, every issue a
	// worker holds; a worker's issue that has closed is read on its own.
	const open = await ghJson<RawIssue[]>(
		['api', `repos/${slug}/issues?state=open&per_page=100`],
		repo.gitRoot
	);
	if (open === null) return;
	const seen = new Map<number, IssueInfo>();
	for (const issue of open) if (!issue.pull_request) seen.set(issue.number, toIssueInfo(issue));
	for (const n of repo.wanted) {
		if (seen.has(n)) continue;
		const one = await ghJson<RawIssue>(['api', `repos/${slug}/issues/${n}`], repo.gitRoot);
		if (one) seen.set(n, toIssueInfo(one));
	}

	const tickets = ticketsFromIssues(open, slug, repo.gitRoot);
	// A worker explains what it needs in a comment; read the latest one once
	// per change to the issue.
	const notes = new Map<string, string | null>();
	for (const t of tickets) {
		if (t.kind !== 'needs-help') continue;
		const raw = open.find((i) => i.number === t.number);
		const key = `${t.number}@${raw?.updated_at}`;
		let note = repo.notes.get(key);
		if (note === undefined) {
			const comments = await ghJson<{ body?: string }[]>(
				['api', `repos/${slug}/issues/${t.number}/comments?per_page=100`],
				repo.gitRoot
			);
			const last = comments?.at(-1)?.body;
			note = last ? firstParagraph(last) : null;
		}
		notes.set(key, note);
		t.note = note;
	}

	repo.issues = seen;
	repo.tickets = tickets;
	repo.notes = notes;
	repo.fetchedAt = Date.now();
}

/**
 * Say which repos the sessions are in, and which issues they work. Called by
 * the session poll every tick; starts a background read for any repo whose
 * answer has gone stale, and drops repos nobody has pointed at for a while.
 */
export function watchRepos(wants: Map<string, Set<number>>): void {
	const now = Date.now();
	for (const [gitRoot, issues] of wants) {
		let repo = repos.get(gitRoot);
		if (!repo) {
			repo = {
				gitRoot,
				slug: null,
				slugTriedAt: 0,
				issues: new Map(),
				tickets: [],
				notes: new Map(),
				wanted: new Set(),
				fetchedAt: 0,
				seenAt: now,
				inflight: false
			};
			repos.set(gitRoot, repo);
		}
		repo.seenAt = now;
		// A worker the poll has not asked about before is read at once, so its
		// row names its issue within a tick or two rather than a minute.
		const fresh = [...issues].some((n) => !repo.wanted.has(n) && !repo.issues.has(n));
		repo.wanted = issues;
		if (repo.inflight || (!fresh && now - repo.fetchedAt < REFRESH_MS)) continue;
		repo.inflight = true;
		const r = repo;
		void refresh(r)
			.catch(() => {})
			.finally(() => {
				r.inflight = false;
				// Even a failed read waits its turn, or a repo without `gh` access
				// would be asked twice a second.
				if (r.fetchedAt < now) r.fetchedAt = now;
			});
	}
	for (const [gitRoot, repo] of repos) {
		if (now - repo.seenAt > FORGET_MS) repos.delete(gitRoot);
	}
}

/** The issue a session in `gitRoot` works, as last read; null until then. */
export function issueFor(gitRoot: string | null, n: number | null | undefined): IssueInfo | null {
	if (!gitRoot || n === null || n === undefined) return null;
	return repos.get(gitRoot)?.issues.get(n) ?? null;
}

/** Every ticket waiting on a person, across the repos being watched. */
export function inboxTickets(): InboxTicket[] {
	return [...repos.values()].flatMap((r) => r.tickets);
}
