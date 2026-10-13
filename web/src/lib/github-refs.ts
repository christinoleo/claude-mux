/**
 * The browser's side of a GitHub chip: asking the server what a pull request
 * or issue is, once per reference and again when the answer has gone stale,
 * and drawing that answer into the `a.gh-ref` the markdown left in a message.
 */

import { githubRefVisual, parseRefNumber, type GithubRef } from '$shared/github-ref.js';

/** How long an answer stands here before the server is asked again. */
const TTL_MS = 60_000;
/** An answer of nothing may only mean the server could not ask yet, so it stands for less. */
const NOTHING_TTL_MS = 10_000;
const MAX_ANSWERS = 300;

/** What a chip asks about: a repo by name, or the repo of `session` for a bare `#n`. */
export interface GithubRefQuery {
	repo: string | null;
	session: string | null;
	number: number;
}

const answers = new Map<string, { until: number; ref: Promise<GithubRef | null> }>();

function githubRefKey(q: GithubRefQuery): string {
	return q.repo ? `${q.repo.toLowerCase()}#${q.number}` : `@${q.session ?? ''}#${q.number}`;
}

async function fetchRef(q: GithubRefQuery): Promise<GithubRef | null> {
	const params = new URLSearchParams({ number: String(q.number) });
	if (q.repo) params.set('repo', q.repo);
	else if (q.session) params.set('session', q.session);
	try {
		const res = await fetch(`/api/github/ref?${params}`);
		if (!res.ok) return null;
		return ((await res.json()) as { ref: GithubRef | null }).ref ?? null;
	} catch {
		return null;
	}
}

/** What GitHub says about a reference; null when it says nothing, which leaves the link plain. */
export function loadGithubRef(q: GithubRefQuery): Promise<GithubRef | null> {
	const key = githubRefKey(q);
	const have = answers.get(key);
	if (have && Date.now() < have.until) return have.ref;
	const ref = fetchRef(q);
	const entry = { until: Date.now() + TTL_MS, ref };
	answers.delete(key);
	answers.set(key, entry);
	if (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value!);
	void ref.then((found) => {
		if (!found) entry.until = Date.now() + NOTHING_TTL_MS;
	});
	return ref;
}

/** The query a chip's attributes spell, or null for an element that is not one. */
export function chipQuery(a: HTMLElement, session: string | null): GithubRefQuery | null {
	const number = parseRefNumber(a.dataset.number);
	if (number === null) return null;
	const repo = a.dataset.repo ?? null;
	if (!repo && !session) return null;
	return { repo, session: repo ? null : session, number };
}

/**
 * Draw an answer into a chip: the state's icon and colour, then `#n` and the
 * title, or the author's own words where the link had some. A bare `#n` in
 * prose gets the icon alone and becomes a link here, since only now is it
 * known to name anything. Drawing again with a newer answer updates in place.
 */
export function drawChip(a: HTMLAnchorElement, ref: GithubRef): void {
	const visual = githubRefVisual(ref);
	const bare = !a.dataset.repo;
	const words = 'words' in a.dataset;

	if (!a.classList.contains('resolved')) {
		const icon = document.createElement('iconify-icon');
		icon.className = 'gh-icon';
		if (words) {
			a.prepend(icon);
		} else {
			const number = document.createElement('span');
			number.className = 'gh-num';
			number.textContent = `#${ref.number}`;
			const title = document.createElement('span');
			title.className = 'gh-title';
			a.replaceChildren(icon, number, ...(bare ? [] : [title]));
		}
		if (bare) {
			a.href = ref.url;
			a.target = '_blank';
			a.rel = 'noopener';
		}
		a.classList.add('resolved');
	}

	const icon = a.querySelector('.gh-icon');
	icon?.setAttribute('icon', visual.icon);
	icon?.setAttribute('aria-label', visual.label);
	const title = a.querySelector('.gh-title');
	if (title) title.textContent = ref.title;
	a.dataset.state = ref.state;
	a.style.setProperty('--gh', visual.color);
}
