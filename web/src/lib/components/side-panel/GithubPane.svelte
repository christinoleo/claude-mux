<script lang="ts">
	/**
	 * A pull request or issue drawn from GitHub's data, read-only, so a link to
	 * one opens beside the session (github.com refuses to be framed). The
	 * header says where it stands; for a pull request the reviews and checks
	 * follow; then the body and the conversation, newest first.
	 *
	 * `?ref=owner/name#n` names what shows. With none, the pane shows the pull
	 * request of the session's branch, else the issue the session works on as a
	 * worker. The row of refs above the header holds both, and the last few
	 * opened here, to go back with a click.
	 */
	import { untrack } from 'svelte';
	import type { PaneBodyProps } from '$lib/side-panel/panes';
	import { sessionApiAt } from '$lib/stores/fleet.svelte';
	import { clock } from '$lib/stores/clock.svelte';
	import { formatAgo } from '$lib/format';
	import { renderMarkdown } from '$lib/markdown';
	import { githubRefVisual } from '$shared/github-ref.js';
	import {
		describeChecks,
		groupChecks,
		parseRefParam,
		readableComments,
		refParam,
		visibleBody,
		type GithubComment,
		type ReviewVerdict
	} from '$shared/github-item.js';
	import {
		loadGithubItem,
		loadSessionGithub,
		mediaHref,
		peekGithubItem,
		type GithubItemResult,
		type SessionGithub
	} from '$lib/github-items';
	import GithubRefCards from '$lib/components/GithubRefCards.svelte';

	let { session, target, base, params, setParams, setActions, active }: PaneBodyProps = $props();

	/** How often an item on screen is read again; the server's cache and ETag make most of these free. */
	const REFRESH_MS = 60_000;
	const COMMENT_PAGE = 10;
	const RECENT_MAX = 6;

	// ── what shows ───────────────────────────────────────────────────────

	let defaults = $state<SessionGithub | null>(null);
	const sessionId = $derived(session?.id ?? null);
	$effect(() => {
		const id = sessionId;
		if (!id || !active) return;
		const api = sessionApiAt(base, id);
		untrack(() => {
			if (defaults) return;
			void loadSessionGithub(api).then((d) => {
				if (sessionId === id) defaults = d;
			});
		});
	});

	const picked = $derived(parseRefParam(params.ref));
	const fallback = $derived.by(() => {
		if (!defaults?.repo) return null;
		const number = defaults.pull ?? defaults.issue;
		return number ? { repo: defaults.repo, number } : null;
	});
	const shown = $derived(picked ?? fallback);
	const shownKey = $derived(shown ? refParam(shown.repo, shown.number) : null);

	function openRef(ref: string) {
		if (ref !== params.ref) setParams({ ref }, { push: true });
	}

	// ── recently opened, per session, kept in this browser ───────────────

	const recentKey = $derived(`gh-pane-recent:${base}|${target}`);
	let recent = $state<string[]>([]);
	$effect(() => {
		const k = recentKey;
		try {
			const kept = JSON.parse(localStorage.getItem(k) ?? '[]');
			recent = Array.isArray(kept) ? kept.filter((r) => typeof r === 'string' && parseRefParam(r)) : [];
		} catch {
			recent = [];
		}
	});
	$effect(() => {
		const ref = shownKey;
		if (!ref) return;
		untrack(() => {
			if (recent[0] === ref) return;
			recent = [ref, ...recent.filter((r) => r !== ref)].slice(0, RECENT_MAX);
			try {
				localStorage.setItem(recentKey, JSON.stringify(recent));
			} catch {
				// Storage may be off; the list then lasts as long as the page.
			}
		});
	});

	/** The shortcuts above the header: the session's own two, then what was opened here. */
	const shortcuts = $derived.by(() => {
		const list: { ref: string; label: string; icon: string; hint: string }[] = [];
		const repo = defaults?.repo;
		if (repo && defaults?.pull) {
			list.push({ ref: refParam(repo, defaults.pull), label: `#${defaults.pull}`, icon: 'mdi:source-branch', hint: "This branch's pull request" });
		}
		if (repo && defaults?.issue) {
			list.push({ ref: refParam(repo, defaults.issue), label: `#${defaults.issue}`, icon: 'mdi:account-hard-hat-outline', hint: 'The issue this worker owns' });
		}
		for (const ref of recent) {
			if (list.some((s) => s.ref === ref)) continue;
			const p = parseRefParam(ref)!;
			const own = p.repo.toLowerCase() === repo?.toLowerCase();
			list.push({ ref, label: own ? `#${p.number}` : ref, icon: 'mdi:history', hint: `Opened lately: ${ref}` });
		}
		return list;
	});

	// ── the read ─────────────────────────────────────────────────────────

	let result = $state<GithubItemResult | null>(null);
	let loading = $state(false);
	let seq = 0;

	async function load(repo: string, number: number, fresh = false) {
		const mine = ++seq;
		loading = true;
		const answer = await loadGithubItem(base, repo, number, fresh);
		if (mine !== seq) return;
		// A failed refresh keeps what is on screen.
		if (answer.item || !result?.item || refParam(result.item.repo, result.item.number) !== refParam(repo, number)) {
			result = answer;
		}
		loading = false;
	}

	$effect(() => {
		const want = shown;
		if (!want) return;
		untrack(() => {
			const ready = peekGithubItem(base, want.repo, want.number);
			result = ready;
			olderShown = 0;
			showBots = false;
			checksOpen = false;
			passingOpen = false;
			expanded = new Set();
			scroller?.scrollTo({ top: 0 });
			void load(want.repo, want.number);
		});
	});

	$effect(() => {
		const want = shown;
		if (!want || !active) return;
		const id = setInterval(() => void load(want.repo, want.number), REFRESH_MS);
		return () => clearInterval(id);
	});

	const item = $derived(result?.item ?? null);
	const visual = $derived(item && githubRefVisual(item));
	const pull = $derived(item?.pull ?? null);

	$effect(() => {
		const want = shown;
		setActions(
			want
				? [
						{ icon: 'mdi:refresh', label: 'Read again', run: () => void load(want.repo, want.number, true), disabled: loading },
						{ icon: 'mdi:open-in-new', label: 'Open on GitHub', run: () => window.open(item?.url ?? githubUrl(want.repo, want.number), '_blank', 'noopener') }
					]
				: []
		);
	});

	function githubUrl(repo: string, number: number): string {
		// GitHub sends an issue URL on to the pull request when the number is one.
		return `https://github.com/${repo}/issues/${number}`;
	}

	// ── the header folds as the body scrolls ─────────────────────────────

	let scroller = $state<HTMLElement | null>(null);
	let folded = $state(false);

	// ── reviews and checks ───────────────────────────────────────────────

	const VERDICT: Record<Exclude<ReviewVerdict, 'dismissed'>, { icon: string; word: string; tone: string }> = {
		approved: { icon: 'mdi:check-circle', word: 'Approved', tone: 'good' },
		changes_requested: { icon: 'mdi:file-document-edit-outline', word: 'Changes requested', tone: 'bad' },
		commented: { icon: 'mdi:comment-outline', word: 'Commented', tone: 'quiet' }
	};

	let checksOpen = $state(false);
	let passingOpen = $state(false);
	const checks = $derived(pull ? groupChecks(pull.checks) : null);
	const checksTone = $derived(!checks ? 'quiet' : checks.failing.length ? 'bad' : checks.running.length ? 'busy' : 'good');

	// ── the conversation ─────────────────────────────────────────────────

	let olderShown = $state(0);
	let showBots = $state(false);
	let expanded = $state(new Set<string>());
	const talk = $derived(item?.comments ? readableComments(item.comments) : null);
	/** Newest first. */
	const listed = $derived.by(() => {
		if (!talk) return [];
		const all = showBots ? [...talk.people, ...talk.bots].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) : talk.people;
		return [...all].reverse();
	});
	const visibleComments = $derived(listed.slice(0, COMMENT_PAGE + olderShown));
	const unread = $derived(item ? Math.max(0, item.comments_total - (item.comments?.length ?? 0)) : 0);

	function md(text: string): string {
		return renderMarkdown(text, { github: { bare: true }, githubBody: { media: mediaHref(base) } });
	}

	/** Marks a comment whose body runs past the cap, so it can offer the rest. */
	function capped(node: HTMLElement) {
		const check = () => node.classList.toggle('long', node.scrollHeight > node.clientHeight + 24);
		const seen = new ResizeObserver(check);
		seen.observe(node);
		check();
		return { destroy: () => seen.disconnect() };
	}

	function toggleComment(c: GithubComment) {
		const next = new Set(expanded);
		if (next.has(c.id)) next.delete(c.id);
		else next.add(c.id);
		expanded = next;
	}

	function ago(at: number | null): string {
		if (!at) return '';
		const a = formatAgo(at, clock.now);
		return a === 'now' ? 'just now' : `${a} ago`;
	}

	function labelStyle(color: string): string {
		const hex = /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : '#78716c';
		return `--label: ${hex}`;
	}
</script>

<div class="gh">
	{#if shortcuts.length > 0}
		<nav class="refs" aria-label="Pull requests and issues">
			{#each shortcuts as s (s.ref)}
				<button type="button" class="ref" class:on={s.ref === shownKey} title={s.hint} onclick={() => openRef(s.ref)}>
					<iconify-icon icon={s.icon}></iconify-icon>
					<span>{s.label}</span>
				</button>
			{/each}
		</nav>
	{/if}

	{#if !shown}
		<div class="empty">
			<iconify-icon icon="mdi:github"></iconify-icon>
			{#if !defaults}
				<p>Looking for this session's pull request…</p>
			{:else if !defaults.repo}
				<p>This session is not in a GitHub repo.</p>
			{:else}
				<p>No pull request for this branch yet. Click a link to an issue or pull request in the conversation to open it here.</p>
			{/if}
		</div>
	{:else if !item}
		{#if result?.error}
			<div class="empty">
				<iconify-icon icon="mdi:github"></iconify-icon>
				{#if result.error === 'no-gh'}
					<p>The GitHub CLI is not signed in on this session's machine. Run <code>gh auth login</code> there to read it here.</p>
				{:else if result.error === 'not-found'}
					<p>GitHub has no {shown.repo}#{shown.number}, or this machine cannot see it.</p>
				{:else}
					<p>GitHub did not answer for {shown.repo}#{shown.number}.</p>
				{/if}
				<a class="out" href={githubUrl(shown.repo, shown.number)} target="_blank" rel="noopener">
					Open on github.com <iconify-icon icon="mdi:open-in-new"></iconify-icon>
				</a>
			</div>
		{:else}
			<div class="ghost" aria-busy="true" aria-label="Loading">
				<span style:width="40%"></span>
				<span style:width="85%"></span>
				<span style:width="60%"></span>
				<span class="gap" style:width="100%"></span>
				<span style:width="92%"></span>
				<span style:width="70%"></span>
			</div>
		{/if}
	{:else if visual}
		<header class="head" class:folded style:--state={visual.color}>
			<div class="line1">
				<span class="state">
					<iconify-icon icon={visual.icon}></iconify-icon>
					{visual.label}
				</span>
				<a class="num" href={item.url} target="_blank" rel="noopener" title="Open on GitHub">
					{item.repo.toLowerCase() === defaults?.repo?.toLowerCase() ? '' : item.repo}#{item.number}
				</a>
				{#if result?.stale}<span class="stale" title="GitHub did not answer the last read; this is the one before">not current</span>{/if}
				{#if folded && pull}
					<span class="mini"><span class="add">+{pull.additions}</span> <span class="del">−{pull.deletions}</span></span>
				{/if}
			</div>
			<h2 title={item.title}>{item.title}</h2>
			<div class="fold">
				<div class="fold-in">
					<p class="meta">
						{#if item.author}<span class="who">{item.author}</span>{/if}
						{#if item.updated_at}<span title={new Date(item.updated_at).toLocaleString()}>updated {ago(item.updated_at)}</span>{/if}
					</p>
					{#if pull}
						<p class="branch">
							<span class="names" title="{pull.base} ← {pull.head}">
								<span class="b">{pull.base}</span>
								<iconify-icon icon="mdi:arrow-left"></iconify-icon>
								<span class="b">{pull.head}</span>
							</span>
							<span class="nums">
								<span class="add">+{pull.additions}</span>
								<span class="del">−{pull.deletions}</span>
								<span>{pull.files} {pull.files === 1 ? 'file' : 'files'}</span>
							</span>
						</p>
					{/if}
					{#if item.labels.length}
						<p class="labels">
							{#each item.labels as l (l.name)}
								<span class="label" style={labelStyle(l.color)}>{l.name}</span>
							{/each}
						</p>
					{/if}
				</div>
			</div>
		</header>

		<div class="scroll" bind:this={scroller} onscroll={(e) => (folded = e.currentTarget.scrollTop > 24)}>
			{#if pull && (pull.reviews.length || pull.requested.length || pull.checks.length)}
				<section class="facts" aria-label="Reviews and checks">
					{#each pull.reviews as r (r.author)}
						{@const v = VERDICT[r.verdict as keyof typeof VERDICT]}
						<div class="fact {v.tone}" class:old={r.stale} title={r.stale ? 'Given before the latest commit' : undefined}>
							<iconify-icon icon={v.icon}></iconify-icon>
							<span class="who">{r.author}</span>
							<span class="word">{v.word.toLowerCase()}</span>
							{#if r.at}<span class="when">{ago(r.at)}</span>{/if}
						</div>
					{/each}
					{#if pull.requested.length}
						<div class="fact quiet">
							<iconify-icon icon="mdi:account-clock-outline"></iconify-icon>
							<span class="word">Waiting on {pull.requested.join(', ')}</span>
						</div>
					{/if}
					{#if checks && pull.checks.length}
						<button type="button" class="fact checks {checksTone}" aria-expanded={checksOpen} onclick={() => (checksOpen = !checksOpen)}>
							<iconify-icon
								icon={checksTone === 'bad' ? 'mdi:close-circle' : checksTone === 'busy' ? 'mdi:progress-clock' : 'mdi:check-circle'}
							></iconify-icon>
							<span class="word">{describeChecks(pull.checks)}</span>
							<iconify-icon class="chev" icon={checksOpen ? 'mdi:chevron-up' : 'mdi:chevron-down'}></iconify-icon>
						</button>
						{#if checksOpen}
							<ul class="checklist">
								{#each [...checks.failing, ...checks.running, ...(passingOpen || (!checks.failing.length && !checks.running.length) ? checks.passing : [])] as c, i (`${c.name}:${i}`)}
									<li class={c.bucket}>
										<iconify-icon
											icon={c.bucket === 'failing' ? 'mdi:close-circle' : c.bucket === 'running' ? 'mdi:progress-clock' : 'mdi:check-circle'}
										></iconify-icon>
										{#if c.url}
											<a href={c.url} target="_blank" rel="noopener">{c.name}</a>
										{:else}
											<span class="name">{c.name}</span>
										{/if}
										<span class="status">{c.status}</span>
									</li>
								{/each}
							</ul>
							{#if !passingOpen && checks.passing.length && (checks.failing.length || checks.running.length)}
								<button type="button" class="more" onclick={() => (passingOpen = true)}>Show {checks.passing.length} passing</button>
							{/if}
						{/if}
					{/if}
				</section>
			{/if}

			<article class="body markdown">
				{#if visibleBody(item.body)}
					{@html md(item.body)}
				{:else}
					<p class="none">No description.</p>
				{/if}
			</article>

			<section class="talk" aria-label="Comments">
				<div class="talk-head">
					<span>{item.comments_total} {item.comments_total === 1 ? 'comment' : 'comments'}</span>
					{#if talk?.bots.length}
						<button type="button" class="more" aria-pressed={showBots} onclick={() => (showBots = !showBots)}>
							{showBots ? `Hide ${talk.bots.length} from bots` : `${talk.bots.length} from bots hidden`}
						</button>
					{/if}
				</div>
				{#if item.comments === null}
					<p class="none">The comments could not be read.</p>
				{/if}
				{#each visibleComments as c (c.id)}
					<div class="comment" class:bot={c.bot}>
						<p class="c-head">
							<span class="who">{c.author}</span>
							{#if c.at}
								<a class="when" href={c.url} target="_blank" rel="noopener" title={new Date(c.at).toLocaleString()}>{ago(c.at)}</a>
							{/if}
						</p>
						<div class="c-body markdown" class:open={expanded.has(c.id)} use:capped>
							{@html md(c.body)}
						</div>
						<button type="button" class="more showmore" onclick={() => toggleComment(c)}>
							{expanded.has(c.id) ? 'Show less' : 'Show more'}
						</button>
					</div>
				{/each}
				{#if listed.length > visibleComments.length}
					<button type="button" class="more older" onclick={() => (olderShown += COMMENT_PAGE)}>
						Show older ({listed.length - visibleComments.length} more)
					</button>
				{:else if unread}
					<a class="more older" href={item.url} target="_blank" rel="noopener">{unread} older on GitHub</a>
				{/if}
			</section>
		</div>
		{#if scroller}
			<GithubRefCards root={scroller} repo={item.repo} {base} onOpen={openRef} />
		{/if}
	{/if}
</div>

<style>
	.gh {
		height: 100%;
		display: flex;
		flex-direction: column;
		font-size: 13px;
		color: #d6d3d1;
		min-width: 0;
	}
	.refs {
		flex: none;
		display: flex;
		gap: 4px;
		padding: 6px 10px;
		border-bottom: 1px solid #222;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.ref {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		max-width: 16rem;
		padding: 0 8px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: #a8a29e;
		font: inherit;
		font-family: var(--font-mono);
		font-size: 11.5px;
		cursor: pointer;
	}
	.ref span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ref:hover {
		color: #e7e5e4;
		background: #1a1a1a;
	}
	.ref.on {
		color: #f5f5f4;
		border-color: #2a2a2a;
		background: #1f1f1f;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		padding: 24px 18px;
		color: #a8a29e;
		line-height: 1.5;
	}
	.empty > iconify-icon {
		font-size: 22px;
		color: #57534e;
	}
	.empty p {
		margin: 0;
		max-width: 34rem;
	}
	.empty code {
		font-family: var(--font-mono);
		font-size: 12px;
		background: #292524;
		border-radius: 4px;
		padding: 1px 5px;
	}
	.out {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: #93c5fd;
	}
	.ghost {
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding: 18px;
	}
	.ghost span {
		height: 11px;
		border-radius: 4px;
		background: #1c1c1c;
		animation: ghost 1.4s ease-in-out infinite;
	}
	.ghost .gap {
		height: 1px;
		margin: 6px 0;
	}
	@keyframes ghost {
		50% {
			opacity: 0.45;
		}
	}

	/* The header: its left rule and the state word carry the state's colour, nothing else does. */
	.head {
		flex: none;
		padding: 10px 14px 10px 12px;
		border-bottom: 1px solid #222;
		border-left: 2px solid var(--state);
	}
	.line1 {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
	}
	.state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--state);
		font-weight: 600;
	}
	.state iconify-icon {
		font-size: 15px;
	}
	.num {
		font-family: var(--font-mono);
		color: #a8a29e;
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.num:hover {
		color: #e7e5e4;
		text-decoration: underline;
	}
	.stale {
		padding: 0 5px;
		border: 1px solid #3a3532;
		border-radius: 4px;
		font-size: 10.5px;
		color: #a8a29e;
	}
	.mini {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: 11px;
	}
	h2 {
		margin: 4px 0 0;
		font-size: 14.5px;
		font-weight: 600;
		line-height: 1.35;
		color: #f5f5f4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fold {
		display: grid;
		grid-template-rows: 1fr;
		transition: grid-template-rows 160ms ease;
	}
	.folded .fold {
		grid-template-rows: 0fr;
	}
	.fold-in {
		overflow: hidden;
		min-height: 0;
	}
	.meta,
	.branch,
	.labels {
		margin: 6px 0 0;
		display: flex;
		align-items: center;
		gap: 4px 10px;
		flex-wrap: wrap;
		font-size: 12px;
		color: #a8a29e;
	}
	.who {
		color: #d6d3d1;
		font-weight: 500;
	}
	.branch {
		flex-wrap: nowrap;
		font-family: var(--font-mono);
		font-size: 11.5px;
	}
	.names {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.names iconify-icon {
		flex: none;
		color: #57534e;
	}
	.b {
		min-width: 0;
		max-width: 50%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #d6d3d1;
	}
	.nums {
		flex: none;
		display: flex;
		gap: 6px;
	}
	.add {
		color: #3f9d63;
	}
	.del {
		color: #b4565a;
	}
	.label {
		padding: 0 7px;
		border: 1px solid color-mix(in srgb, var(--label) 55%, #111);
		border-radius: 999px;
		background: color-mix(in srgb, var(--label) 16%, #111);
		color: color-mix(in srgb, var(--label) 45%, #e7e5e4);
		font-size: 11px;
		line-height: 1.6;
	}

	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-bottom: 24px;
	}
	.facts {
		display: flex;
		flex-direction: column;
		padding: 8px 0;
		border-bottom: 1px solid #222;
	}
	.fact {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 28px;
		padding: 0 14px;
		border: 0;
		background: transparent;
		color: #a8a29e;
		font: inherit;
		font-size: 12.5px;
		text-align: left;
	}
	.fact iconify-icon {
		flex: none;
		font-size: 15px;
	}
	.fact.good iconify-icon {
		color: #34d399;
	}
	.fact.bad iconify-icon {
		color: #f87171;
	}
	.fact.busy iconify-icon {
		color: #a8a29e;
	}
	.fact.quiet iconify-icon {
		color: #78716c;
	}
	.fact.old {
		opacity: 0.5;
	}
	.fact .when {
		margin-left: auto;
		font-size: 11.5px;
		color: #78716c;
	}
	.checks {
		cursor: pointer;
	}
	.checks:hover {
		background: #171717;
	}
	.checks .word {
		color: #d6d3d1;
	}
	.chev {
		margin-left: auto;
		color: #78716c;
	}
	.checklist {
		margin: 2px 0 4px;
		padding: 0;
		list-style: none;
	}
	.checklist li {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 26px;
		padding: 0 14px 0 34px;
		font-size: 12px;
	}
	.checklist iconify-icon {
		flex: none;
		font-size: 13px;
	}
	.checklist .failing iconify-icon {
		color: #f87171;
	}
	.checklist .running iconify-icon {
		color: #a8a29e;
	}
	.checklist .passing iconify-icon {
		color: #34d399;
	}
	.checklist a,
	.checklist .name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #d6d3d1;
		text-decoration: none;
	}
	.checklist a:hover {
		text-decoration: underline;
	}
	.status {
		flex: none;
		color: #78716c;
		font-size: 11.5px;
	}
	.more {
		align-self: flex-start;
		margin: 2px 14px;
		padding: 2px 0;
		border: 0;
		background: none;
		color: #93c5fd;
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		text-decoration: none;
	}
	.more:hover {
		text-decoration: underline;
	}
	.body {
		padding: 14px;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	.none {
		margin: 0;
		color: #78716c;
	}
	.talk {
		display: flex;
		flex-direction: column;
		border-top: 1px solid #222;
	}
	.talk-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px 14px 4px;
		font-size: 12px;
		color: #78716c;
	}
	.talk-head .more {
		margin: 0;
	}
	.talk > .none {
		padding: 6px 14px;
	}
	.comment {
		display: flex;
		flex-direction: column;
		padding: 10px 14px;
		border-bottom: 1px solid #1c1c1c;
		/* Long bot reports off screen skip layout until scrolled to. */
		content-visibility: auto;
		contain-intrinsic-block-size: auto 120px;
	}
	.comment.bot {
		opacity: 0.8;
	}
	.c-head {
		margin: 0 0 4px;
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 12px;
	}
	.c-head .when {
		color: #78716c;
		text-decoration: none;
	}
	.c-head .when:hover {
		color: #a8a29e;
		text-decoration: underline;
	}
	.c-body {
		max-height: 240px;
		overflow: hidden;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	.c-body:global(.long):not(.open) {
		mask-image: linear-gradient(to bottom, #000 70%, transparent);
	}
	.c-body.open {
		max-height: none;
	}
	.showmore {
		display: none;
		margin: 4px 0 0;
	}
	.c-body:global(.long) + .showmore,
	.c-body.open + .showmore {
		display: inline;
	}
	.older {
		margin: 10px 14px;
	}

	/* What a body holds beyond the transcript's markdown. */
	.gh :global(.markdown img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
	}
	.gh :global(.markdown details) {
		margin: 6px 0;
		padding: 4px 10px;
		border: 1px solid #262626;
		border-radius: 6px;
	}
	.gh :global(.markdown summary) {
		cursor: pointer;
		color: #a8a29e;
	}
	.gh :global(.markdown details[open] > summary) {
		margin-bottom: 6px;
	}
	.gh :global(.gh-alert) {
		margin: 8px 0;
		padding: 2px 0 2px 12px;
		border-left: 3px solid var(--alert);
	}
	.gh :global(.gh-alert-title) {
		color: var(--alert);
		font-weight: 600;
		margin-bottom: 3px;
	}
	.gh :global(.gh-alert-note) {
		--alert: #60a5fa;
	}
	.gh :global(.gh-alert-tip) {
		--alert: #34d399;
	}
	.gh :global(.gh-alert-important) {
		--alert: #a78bfa;
	}
	.gh :global(.gh-alert-warning) {
		--alert: #fb923c;
	}
	.gh :global(.gh-alert-caution) {
		--alert: #f87171;
	}
	.ref:focus-visible,
	.fact:focus-visible,
	.more:focus-visible,
	.num:focus-visible {
		outline: 2px solid #7dd3fc;
		outline-offset: -2px;
	}
	@media (pointer: coarse) {
		.ref {
			height: 34px;
		}
		.fact {
			min-height: 36px;
		}
		.more {
			padding: 8px 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.fold {
			transition: none;
		}
		.ghost span {
			animation: none;
		}
	}
</style>
