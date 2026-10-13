/**
 * A GitHub pull request or issue named in a message: what a link to one looks
 * like, what the server answers about it, and how each state is drawn. Shared
 * by the server that reads GitHub and the transcript that draws the chip.
 */

export type GithubRefKind = 'pull' | 'issue';
export type GithubRefState = 'open' | 'draft' | 'merged' | 'closed';

/** What GitHub says about one pull request or issue. */
export interface GithubRef {
	/** `owner/name`. */
	repo: string;
	number: number;
	kind: GithubRefKind;
	title: string;
	state: GithubRefState;
	draft: boolean;
	/** The login of whoever opened it. */
	author: string | null;
	/** When it last changed, in ms. */
	updated_at: number | null;
	url: string;
}

/** Where a link points, read off its URL alone. */
export interface GithubRefTarget {
	repo: string;
	number: number;
	kind: GithubRefKind;
}

const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})`;
const NAME = String.raw`[A-Za-z0-9._-]{1,100}`;
const SLUG = new RegExp(`^${OWNER}/(${NAME})$`);
/** A pull request or issue, with whatever GitHub hangs after it (`/files`, `#issuecomment-1`). */
const REF_URL = new RegExp(
	String.raw`^https?://(?:www\.)?github\.com/(${OWNER}/${NAME})/(pull|issues)/([1-9]\d{0,8})(?:[/?#].*)?$`
);

/** Whether `slug` is an `owner/name` and nothing else, safe to put in an API path. */
export function isRepoSlug(slug: string): boolean {
	const name = SLUG.exec(slug)?.[1];
	return name !== undefined && name !== '.' && name !== '..';
}

/** A pull request or issue number as written in a query: digits, no sign, no zero. */
export function parseRefNumber(text: string | null | undefined): number | null {
	return text && /^[1-9]\d{0,8}$/.test(text) ? Number(text) : null;
}

/** The pull request or issue a URL points at, or null for any other URL. */
export function parseGithubRefUrl(href: string): GithubRefTarget | null {
	const m = REF_URL.exec(href);
	if (!m || !isRepoSlug(m[1])) return null;
	return { repo: m[1], number: Number(m[3]), kind: m[2] === 'pull' ? 'pull' : 'issue' };
}

/** Whether a link's text is only a name for its target (`#12`, `owner/name#12`), not words of the author's. */
export function isRefShorthand(text: string, target: GithubRefTarget): boolean {
	const t = text.trim();
	return t === `#${target.number}` || t.toLowerCase() === `${target.repo}#${target.number}`.toLowerCase();
}

export interface GithubRefVisual {
	icon: string;
	color: string;
	label: string;
}

// Emerald is the palette's "going well", violet its "work a session did", grey
// what recedes. Amber is left out on purpose: it is reserved for what wants a
// person, and no state of a pull request does.
const PULL: Record<GithubRefState, GithubRefVisual> = {
	open: { icon: 'mdi:source-pull', color: '#34d399', label: 'Open' },
	draft: { icon: 'mdi:source-pull', color: '#a8a29e', label: 'Draft' },
	merged: { icon: 'mdi:source-merge', color: '#c4b5fd', label: 'Merged' },
	closed: { icon: 'mdi:source-pull', color: '#f87171', label: 'Closed' }
};
const ISSUE_OPEN: GithubRefVisual = { icon: 'mdi:record-circle-outline', color: '#34d399', label: 'Open' };
const ISSUE_CLOSED: GithubRefVisual = { icon: 'mdi:check-circle-outline', color: '#c4b5fd', label: 'Closed' };

/** The icon, colour and word for a pull request's or issue's state. */
export function githubRefVisual(ref: Pick<GithubRef, 'kind' | 'state'>): GithubRefVisual {
	if (ref.kind === 'pull') return PULL[ref.state];
	return ref.state === 'open' ? ISSUE_OPEN : ISSUE_CLOSED;
}
