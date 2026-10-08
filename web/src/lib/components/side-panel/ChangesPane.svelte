<script lang="ts">
	/**
	 * What the session changed, from one of two sources: Current (git's
	 * working tree, which catches edits made through Bash) or Session (the
	 * edits in the session's own log, which reach files outside the repo and
	 * know which turn made each). A file list on the left, the selected
	 * file's diff on the right; narrower than the two fit, one at a time.
	 *
	 * The URL holds the file (`file`), the Session turn (`turn`, its number in
	 * the session) and the source (`source`), so a link can open any of it.
	 * While shown, the pane re-reads whenever the session's hooks report in.
	 */
	import { untrack } from 'svelte';
	import type { PaneBodyProps } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import {
		diffRows,
		displayPath,
		isGenerated,
		languageFor,
		statusLetter,
		sumCounts,
		type Diff,
		type DiffRow,
		type Listing,
		type Source
	} from '$lib/side-panel/changes';
	import { highlightLines } from '$lib/side-panel/highlight';

	let { session, params, setParams, setActions, active }: PaneBodyProps = $props();

	const sessionId = $derived(session?.id ?? null);
	/** Git when the session sits in a repo, else its log; a `source` param overrides. */
	const inRepo = $derived(!!session?.git_root || session?.changes?.source === 'git');
	/** Set once git answered that the session is not in a work tree. */
	let gitMissing = $state(false);
	const wanted = $derived<Source>(
		params.source === 'session' || params.source === 'git' ? params.source : inRepo ? 'git' : 'session'
	);
	const source = $derived<Source>(gitMissing && wanted === 'git' ? 'session' : wanted);

	let listing = $state<Listing | null>(null);
	let listError = $state<string | null>(null);
	let loadingList = $state(false);
	let listSeq = 0;

	async function loadList(id: string, src: Source) {
		const mine = ++listSeq;
		loadingList = true;
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/changes?source=${src}`);
			const body = await res.json();
			if (mine !== listSeq) return;
			if (res.status === 404 && src === 'git') {
				gitMissing = true;
				return;
			}
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			listing = body as Listing;
			listError = null;
		} catch (err) {
			if (mine === listSeq) listError = err instanceof Error ? err.message : String(err);
		} finally {
			if (mine === listSeq) loadingList = false;
		}
	}

	/**
	 * Re-read whenever a hook reports in or the broadcast count moves — what
	 * makes git re-read the repo, too. A hidden pane waits until shown.
	 */
	const pulse = $derived(
		`${session?.last_update ?? 0}:${session?.changes?.additions ?? 0}:${session?.changes?.deletions ?? 0}:${session?.changes?.files ?? 0}`
	);
	$effect(() => {
		void pulse;
		if (sessionId && active) void loadList(sessionId, source);
	});

	// A listing for the other source is no answer for this one.
	const current = $derived(listing?.source === source ? listing : null);
	const turns = $derived(current?.turns ?? []);
	const turn = $derived(
		source === 'session' && params.turn !== undefined
			? (turns.find((t) => String(t.n) === params.turn) ?? null)
			: null
	);
	const files = $derived(turn ? turn.files : (current?.files ?? []));
	const root = $derived(current?.root ?? session?.git_root ?? session?.cwd ?? null);
	const totals = $derived(sumCounts(files));
	/** Newest first, each with its own totals. */
	const chips = $derived(turns.map((t) => ({ ...t, ...sumCounts(t.files) })).reverse());

	let showGenerated = $state(false);
	const split = $derived.by(() => {
		const generated: typeof files = [];
		const kept: typeof files = [];
		for (const f of files) (isGenerated(f.file) ? generated : kept).push(f);
		return { generated, kept };
	});
	const shown = $derived(showGenerated ? files : split.kept);

	/** The file the URL names, else the first one listed, so a wide pane never sits empty. */
	const selected = $derived(
		files.find((f) => f.file === params.file) ?? (params.file ? null : (shown[0] ?? null))
	);

	function pick(file: string) {
		setParams({ file });
	}

	function setSource(next: Source) {
		if (next === source) return;
		setParams({ source: next, turn: null, file: null });
	}

	function setTurn(n: number | null) {
		setParams({ turn: n === null ? null : String(n), file: null });
	}

	const NO_PROMPT = 'Before the first prompt';

	/** Scroll the transcript to the prompt that opened a turn; the page does the scrolling. */
	function revealTurn(id: string) {
		window.dispatchEvent(new CustomEvent('claude-mux:reveal-entry', { detail: { id } }));
	}

	// ── the selected file's diff ─────────────────────────────────────────

	let diff = $state<Diff | null>(null);
	let diffError = $state<string | null>(null);
	let diffSeq = 0;
	/** Highlighted HTML per row index, filled in once highlight.js has loaded. */
	let painted = $state<(string | null)[] | null>(null);

	async function loadDiff(id: string, src: Source, file: string, turnId: string | null) {
		const mine = ++diffSeq;
		const q = new URLSearchParams({ source: src, file });
		if (turnId) q.set('turn', turnId);
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/changes/diff?${q}`);
			const body = await res.json();
			if (mine !== diffSeq) return;
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			diff = body as Diff;
			diffError = null;
		} catch (err) {
			if (mine === diffSeq) {
				diff = null;
				diffError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	/** What the diff depends on: a new count for the file means a new diff. */
	const diffKey = $derived(
		selected
			? `${source}\0${selected.file}\0${turn?.id ?? ''}\0${selected.additions}\0${selected.deletions}`
			: null
	);
	$effect(() => {
		if (!diffKey || !sessionId || !active) return;
		// Only the key decides: a reloaded list hands back new objects for the same file.
		const id = sessionId;
		untrack(() => void loadDiff(id, source, selected!.file, turn?.id ?? null));
	});

	const shownDiff = $derived(diff && diff.file === selected?.file ? diff : null);
	const rows = $derived<DiffRow[]>(shownDiff ? diffRows(shownDiff.hunks) : []);
	const hunkCount = $derived(shownDiff?.hunks.length ?? 0);

	const SIGN = { add: '+', del: '−', context: ' ' } as const;

	/** Rows past this many are drawn plain: colouring them costs more than it gives. */
	const PAINT_LIMIT = 4000;
	$effect(() => {
		painted = null;
		if (rows.length === 0 || rows.length > PAINT_LIMIT) return;
		const lines = rows.map((r) => ('text' in r ? r.text : ''));
		const language = untrack(() => languageFor(selected!.file));
		let stale = false;
		void highlightLines(lines, language).then((html) => {
			if (!stale && html) painted = html;
		});
		return () => (stale = true);
	});

	// ── header actions and keys ──────────────────────────────────────────

	$effect(() => {
		setActions([
			{
				icon: 'mdi:refresh',
				label: 'Reload',
				disabled: !sessionId || loadingList,
				run: () => sessionId && void loadList(sessionId, source)
			}
		]);
	});

	/** j/k step through the files, unless someone is typing. */
	function onKey(e: KeyboardEvent) {
		if (!active || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key !== 'j' && e.key !== 'k') return;
		const el = e.target as HTMLElement | null;
		if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
		if (shown.length === 0) return;
		const at = selected ? shown.findIndex((f) => f.file === selected.file) : -1;
		const next = e.key === 'j' ? Math.min(at + 1, shown.length - 1) : Math.max(at - 1, 0);
		e.preventDefault();
		pick(shown[next].file);
		document
			.querySelector(`[data-change-file="${CSS.escape(shown[next].file)}"]`)
			?.scrollIntoView({ block: 'nearest' });
	}

</script>

<svelte:window onkeydown={onKey} />

<div class="changes" class:picked={!!params.file}>
	<div class="bar">
		<span class="title">
			{#if current}
				{files.length} {files.length === 1 ? 'file' : 'files'} changed
				{#if totals.additions || totals.deletions}
					<span class="mono"><span class="add">+{totals.additions}</span> <span class="del">−{totals.deletions}</span></span>
				{/if}
			{:else}
				Changes
			{/if}
		</span>
		<span class="sp"></span>
		<div class="seg" role="group" aria-label="Source">
			<Toggle
				size="sm"
				pressed={source === 'git'}
				disabled={gitMissing}
				title={gitMissing ? 'Not a git repository' : 'What git sees in the working tree now'}
				onPressedChange={() => setSource('git')}>Current · git</Toggle
			>
			<Toggle
				size="sm"
				pressed={source === 'session'}
				title="The edits this session's tools made"
				onPressedChange={() => setSource('session')}>Session</Toggle
			>
		</div>
	</div>

	{#if source === 'session' && turns.length > 0}
		<div class="turns" role="group" aria-label="Turn">
			<button type="button" class="chip" class:on={!turn} aria-pressed={!turn} onclick={() => setTurn(null)}>
				All turns
			</button>
			{#each chips as t (t.n)}
				<button
					type="button"
					class="chip"
					class:on={turn?.n === t.n}
					aria-pressed={turn?.n === t.n}
					title={t.prompt || NO_PROMPT}
					onclick={() => setTurn(t.n)}
				>
					{t.n === 0 ? 'Start' : `Turn ${t.n}`}
					{#if t.additions}<span class="add">+{t.additions}</span>{/if}
					{#if t.deletions}<span class="del">−{t.deletions}</span>{/if}
				</button>
			{/each}
		</div>
		{#if turn}
			<div class="turn-note">
				<span class="prompt" title={turn.prompt}>{turn.prompt || NO_PROMPT}</span>
				{#if turn.id}
					{@const id = turn.id}
					<button type="button" class="link" onclick={() => revealTurn(id)}>Show in transcript</button>
				{/if}
			</div>
		{/if}
	{/if}

	{#if listError && !current}
		<p class="msg err">{listError}</p>
	{:else if !current}
		<p class="msg">Loading…</p>
	{:else if files.length === 0}
		<p class="msg">
			{source === 'git' ? 'The working tree is clean.' : 'This session has not edited any files yet.'}
		</p>
	{:else}
		<div class="split">
			<nav aria-label="Changed files">
				{#each shown as f (f.file)}
					{@const letter = statusLetter(f)}
					<button
						type="button"
						class="file"
						class:on={selected?.file === f.file}
						class:untracked={f.untracked}
						aria-current={selected?.file === f.file ? 'true' : undefined}
						data-change-file={f.file}
						title={f.oldPath ? `${f.oldPath} → ${f.file}` : f.file}
						onclick={() => pick(f.file)}
					>
						<span class="st st-{letter === '?' ? 'u' : letter.toLowerCase()}">{letter}</span>
						<!-- rtl puts the ellipsis on the left; bdi keeps the path itself left to right. -->
						<span class="path"><bdi>{displayPath(f.file, root)}</bdi></span>
						{#if f.binary}
							<span class="dim">bin</span>
						{:else}
							{#if f.additions}<span class="add">+{f.additions}</span>{/if}
							{#if f.deletions}<span class="del">−{f.deletions}</span>{/if}
						{/if}
					</button>
				{/each}
				{#if split.generated.length > 0}
					<button type="button" class="more" onclick={() => (showGenerated = !showGenerated)}>
						{showGenerated ? 'Hide generated' : `+ ${split.generated.length} generated (show)`}
					</button>
				{/if}
			</nav>

			<section class="diff" aria-label="Diff">
				{#if selected}
					<div class="diff-head">
						<button type="button" class="back" aria-label="Back to files" onclick={() => setParams({ file: null })}>
							<iconify-icon icon="mdi:arrow-left"></iconify-icon>
						</button>
						<span class="path" title={selected.file}>{displayPath(selected.file, root)}</span>
						<span class="sp"></span>
						{#if hunkCount}<span class="dim">{hunkCount} {hunkCount === 1 ? 'hunk' : 'hunks'}</span>{/if}
					</div>
					{#if diffError}
						<p class="msg err">{diffError}</p>
					{:else if diff?.binary}
						<p class="msg">Binary file; no text diff.</p>
					{:else if rows.length > 0}
						<div class="lines">
							{#each rows as row, i (i)}
								{#if row.type === 'hunk'}
									<div class="hunk">{row.header}</div>
								{:else if row.type === 'gap'}
									<div class="gap">⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'} ⋯</div>
								{:else}
									<div class="ln {row.type}">
										<span class="no">{row.old ?? ''}</span><span class="no">{row.new ?? ''}</span><span
											class="sign">{SIGN[row.type]}</span
										><!-- eslint-disable-next-line svelte/no-at-html-tags -- highlight.js escapes the text it colours --><span
											class="code">{#if painted?.[i] != null}{@html painted[i]}{:else}{row.text}{/if}</span
										>
									</div>
								{/if}
							{/each}
						</div>
					{:else if diff}
						<p class="msg">No line changes.</p>
					{/if}
				{:else}
					<p class="msg">That file has no change here.</p>
				{/if}
			</section>
		</div>
	{/if}
	<div class="foot"><kbd>j</kbd>/<kbd>k</kbd> next / previous file</div>
</div>

<style>
	.changes {
		height: 100%;
		display: flex;
		flex-direction: column;
		container-type: inline-size;
		font-size: 13px;
		color: #d6d3d1;
	}
	.mono,
	nav,
	.diff,
	.turns {
		font-family: var(--font-mono);
	}
	.bar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		padding: 10px 14px;
		border-bottom: 1px solid #222;
		flex: none;
	}
	.title {
		font-size: 13.5px;
		font-weight: 600;
		color: #e7e5e4;
		display: inline-flex;
		gap: 10px;
		align-items: baseline;
	}
	.title .mono {
		font-size: 12px;
		font-weight: 400;
	}
	.sp {
		flex: 1;
	}
	.seg {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		border-radius: 8px;
		border: 1px solid #2a2a2a;
		background: #1a1a1a;
	}
	.seg :global([data-slot='toggle']) {
		color: #a8a29e;
		height: 30px;
	}
	.seg :global([data-slot='toggle'][data-state='on']) {
		background: #e7e5e4;
		color: #0b0b0b;
	}
	.turns {
		display: flex;
		gap: 6px;
		padding: 8px 14px;
		border-bottom: 1px solid #222;
		overflow-x: auto;
		flex: none;
		font-size: 11.5px;
		scrollbar-width: thin;
	}
	.chip {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 28px;
		padding: 0 10px;
		border-radius: 6px;
		border: 1px solid #2a2a2a;
		background: transparent;
		color: #a8a29e;
		font: inherit;
		cursor: pointer;
	}
	.chip:hover {
		color: #f5f5f4;
	}
	.chip.on {
		border-color: #3f3f46;
		background: #232326;
		color: #f5f5f4;
	}
	.turn-note {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 14px;
		border-bottom: 1px solid #222;
		font-size: 12px;
		color: #a8a29e;
		flex: none;
	}
	.prompt,
	.file .path,
	.diff-head .path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.prompt {
		flex: 1;
	}
	.link {
		flex: none;
		border: 0;
		background: none;
		padding: 4px 0;
		color: #93c5fd;
		font: inherit;
		cursor: pointer;
	}
	.link:hover {
		text-decoration: underline;
	}
	.msg {
		margin: 0;
		padding: 16px 18px;
		color: #78716c;
	}
	.err {
		color: #f87171;
	}
	.split {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	nav {
		width: 250px;
		flex: none;
		overflow-y: auto;
		border-right: 1px solid #222;
		padding: 8px 6px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-size: 12px;
	}
	.file {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 32px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #d6d3d1;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.file:hover {
		background: #1a1a1a;
	}
	.file.on {
		background: #1f1f1f;
		color: #f5f5f4;
	}
	.file.untracked {
		color: #78716c;
	}
	.file .path {
		flex: 1;
		direction: rtl;
		text-align: left;
	}
	.st {
		width: 10px;
		flex: none;
	}
	.st-m,
	.st-r {
		color: #fbbf24;
	}
	.st-a {
		color: #4ade80;
	}
	.st-d {
		color: #f87171;
	}
	.st-u {
		color: #78716c;
	}
	.more {
		border: 0;
		background: none;
		text-align: left;
		padding: 9px 8px 4px;
		min-height: 32px;
		color: #78716c;
		font: inherit;
		font-size: 11.5px;
		cursor: pointer;
	}
	.more:hover {
		color: #d6d3d1;
	}
	.add {
		color: #4ade80;
	}
	.del {
		color: #f87171;
	}
	.dim {
		color: #78716c;
	}
	.diff {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		font-size: 12px;
	}
	.diff-head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		border-bottom: 1px solid #222;
		flex: none;
	}
	.back {
		display: none;
		flex: none;
		width: 44px;
		height: 44px;
		margin: -8px 0 -8px -12px;
		align-items: center;
		justify-content: center;
		border: 0;
		background: none;
		color: #a8a29e;
		font-size: 18px;
		cursor: pointer;
	}
	.lines {
		flex: 1;
		overflow: auto;
		padding: 6px 0 16px;
		line-height: 1.65;
	}
	.hunk {
		padding: 2px 14px;
		color: #78716c;
		background: #161616;
		white-space: pre;
	}
	.gap {
		padding: 3px 14px;
		color: #78716c;
		background: #141414;
		text-align: center;
	}
	.ln {
		display: flex;
		width: max-content;
		min-width: 100%;
		color: #a8a29e;
	}
	.ln.add {
		background: #0f2417;
		color: #bbf7d0;
	}
	.ln.del {
		background: #2a1215;
		color: #fecaca;
	}
	.no {
		flex: none;
		width: 4ch;
		padding-right: 1ch;
		text-align: right;
		color: #57534e;
		user-select: none;
	}
	.sign {
		flex: none;
		width: 2ch;
		text-align: center;
		user-select: none;
	}
	.ln.add .sign {
		color: #4ade80;
	}
	.ln.del .sign {
		color: #f87171;
	}
	.code {
		white-space: pre;
		padding-right: 14px;
	}
	/* highlight.js tokens, muted so the add/del backgrounds still lead. */
	.code :global(.hljs-keyword),
	.code :global(.hljs-built_in),
	.code :global(.hljs-literal),
	.code :global(.hljs-selector-tag) {
		color: #c4b5fd;
	}
	.code :global(.hljs-string),
	.code :global(.hljs-regexp),
	.code :global(.hljs-attr),
	.code :global(.hljs-selector-attr) {
		color: #fcd34d;
	}
	.code :global(.hljs-number),
	.code :global(.hljs-symbol) {
		color: #fdba74;
	}
	.code :global(.hljs-comment),
	.code :global(.hljs-meta) {
		color: #78716c;
		font-style: italic;
	}
	.code :global(.hljs-title),
	.code :global(.hljs-function),
	.code :global(.hljs-section) {
		color: #93c5fd;
	}
	.code :global(.hljs-type),
	.code :global(.hljs-class),
	.code :global(.hljs-name),
	.code :global(.hljs-selector-class) {
		color: #5eead4;
	}
	.code :global(.hljs-variable),
	.code :global(.hljs-template-variable),
	.code :global(.hljs-property) {
		color: #f9a8d4;
	}
	.foot {
		flex: none;
		padding: 8px 14px;
		border-top: 1px solid #222;
		font-size: 11.5px;
		color: #78716c;
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 10.5px;
		padding: 0 4px;
		border-radius: 4px;
		background: #1f1f1f;
		color: #a8a29e;
	}

	/* Too narrow for both: the list, or the picked file's diff with a way back. */
	@container (max-width: 38rem) {
		nav {
			width: auto;
			flex: 1;
			border-right: 0;
		}
		.diff {
			display: none;
		}
		.picked nav {
			display: none;
		}
		.picked .diff {
			display: flex;
		}
		.back {
			display: inline-flex;
		}
		.foot {
			display: none;
		}
		/* A finger needs room. */
		.file,
		.more,
		.chip,
		.link {
			min-height: 44px;
		}
	}
	@media (pointer: coarse) {
		.file,
		.more,
		.chip,
		.link {
			min-height: 44px;
		}
		.seg :global([data-slot='toggle']) {
			height: 40px;
		}
	}
</style>
