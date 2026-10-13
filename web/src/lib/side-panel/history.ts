/**
 * The History pane's pure half: what the API answers with, how a commit's
 * refs read, and the day a commit is filed under.
 */
import type { CommitFile, GitHistory, HistoryCommit } from '$shared/server/git-history.js';

export type { CommitFile };

/** A commit as the list route answers: git's own facts, plus whether this session made it. */
export type Commit = HistoryCommit & {
	mine?: true;
	/** The prompt that opened the turn the commit was made in. */
	turn?: string | null;
};

export type History = Omit<GitHistory, 'commits'> & { commits: Commit[] };

export type RefKind = 'tag' | 'remote' | 'branch';

/** One of git's decorations, sorted into what it is: `tag: v1`, `origin/main`, `main`. */
export function readRef(ref: string, branches: ReadonlySet<string>): { kind: RefKind; name: string } {
	if (ref.startsWith('tag: ')) return { kind: 'tag', name: ref.slice(5) };
	// A local branch may have a slash in its name too, so only the list of checkouts tells them apart.
	return { kind: branches.has(ref) || !ref.includes('/') ? 'branch' : 'remote', name: ref };
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' });

/** The heading a commit is listed under: "Today", "Yesterday", or its date. */
export function dayOf(at: number, now: number): string {
	const start = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
	const days = Math.round((start(now) - start(at)) / 86_400_000);
	return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : DAY.format(at);
}

/** A hash as people say it. */
export const shortHash = (hash: string) => hash.slice(0, 7);
