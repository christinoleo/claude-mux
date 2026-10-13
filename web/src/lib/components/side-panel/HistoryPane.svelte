<script lang="ts">
	/**
	 * The repo's commits, read-only: the list on one side, the picked commit's
	 * files and their diffs on the other, and on a narrow pane the two take
	 * turns. "List" follows the checked-out branch, filed by day; "Graph" adds
	 * every worktree's branch and the upstream, each in a lane of its own, and
	 * names a lane's tip after the worker running there.
	 *
	 * What no other git client can say is said here: which commits this
	 * session made (and the turn that made them), and which have not left the
	 * machine yet.
	 */
	import { untrack } from 'svelte';
	import type { PaneBodyProps } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import { layoutGraph, type GraphRow } from '$shared/git-graph.js';
	import { dayOf, readRef, shortHash, type Commit, type CommitFile, type History } from '$lib/side-panel/history';
	import { statusLetter, type Diff } from '$lib/side-panel/changes';
	import { copyWithToast } from '$lib/side-panel/clipboard';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { clock } from '$lib/stores/clock.svelte';
	import { formatAgo } from '$lib/format';
	import DiffLines from './DiffLines.svelte';

	let { session, params, setParams, setActions, mention, openPane, active }: PaneBodyProps = $props();

	const sessionId = $derived(session?.id ?? null);
	const api = $derived(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/history` : null);
	const graph = $derived(params.view === 'graph');

	// ── the commits ──────────────────────────────────────────────────────

	let history = $state<History | null>(null);
	let listError = $state<string | null>(null);
	let loading = $state(false);
	let listSeq = 0;

	async function loadList(url: string, all: boolean) {
		const mine = ++listSeq;
		loading = true;
		try {
			const res = await fetch(`${url}?scope=${all ? 'all' : 'branch'}`);
			const body = await res.json();
			if (mine !== listSeq) return;
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			history = body as History;
			listError = null;
		} catch (err) {
			if (mine === listSeq) listError = err instanceof Error ? err.message : String(err);
		} finally {
			if (mine === listSeq) loading = false;
		}
	}

	/**
	 * Commits change when a turn ends or the working tree's count moves (a
	 * commit empties it), not with every hook, so that is when the log is read
	 * again. A hidden pane waits until shown.
	 */
	const pulse = $derived(`${session?.turn_completed_at ?? 0}:${session?.changes?.files ?? 0}`);
	$effect(() => {
		void pulse;
		const url = api;
		const all = graph;
		if (url && active) untrack(() => void loadList(url, all));
	});

	const commits = $derived(history?.commits ?? []);
	const layout = $derived(layoutGraph(commits));
	const unpushed = $derived(commits.filter((c) => !c.pushed).length);
	const branches = $derived(new Set((history?.tips ?? []).flatMap((t) => (t.branch ? [t.branch] : []))));

	/** The worker whose worktree has `branch` checked out, named as the sidebar names it. */
	function workerOn(branch: string): string | null {
		const tip = history?.tips.find((t) => t.branch === branch);
		const worker = tip && sessionStore.sessions.find((s) => s.git_root === tip.path && s.maestro_issue != null);
		if (!worker) return null;
		return worker.issue ? `#${worker.maestro_issue} ${worker.issue.title}` : `#${worker.maestro_issue}`;
	}

	// ── drawing a row of the graph ───────────────────────────────────────

	const ROW = 44;
	const LANE = 14;
	const PAD = 11;
	const LANES = ['#a8a29e', '#a78bfa', '#2dd4bf', '#7dd3fc', '#fbbf24', '#f9a8d4'];
	const laneX = (lane: number) => PAD + lane * LANE;
	const laneColor = (lane: number) => LANES[lane % LANES.length];
	const railWidth = $derived(PAD * 2 + Math.max(0, layout.width - 1) * LANE);

	/** A line from a lane at one edge of the row to the commit's dot, bending only if the lanes differ. */
	function bend(lane: number, row: GraphRow, fromTop: boolean): string {
		const x = laneX(lane);
		const cx = laneX(row.lane);
		const edge = fromTop ? 0 : ROW;
		const mid = ROW / 2;
		return x === cx
			? `M${x} ${edge} L${cx} ${mid}`
			: `M${x} ${edge} C${x} ${(edge + mid) / 2} ${cx} ${(edge + mid) / 2} ${cx} ${mid}`;
	}

	// ── the picked commit ────────────────────────────────────────────────

	const picked = $derived(commits.find((c) => c.hash === params.commit) ?? null);

	let files = $state<{ hash: string; files: CommitFile[] } | null>(null);
	let filesError = $state<string | null>(null);
	let filesSeq = 0;
	async function loadFiles(url: string, hash: string) {
		const mine = ++filesSeq;
		try {
			const res = await fetch(`${url}/commit?hash=${hash}`);
			const body = await res.json();
			if (mine !== filesSeq) return;
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			files = body as { hash: string; files: CommitFile[] };
			filesError = null;
		} catch (err) {
			if (mine === filesSeq) filesError = err instanceof Error ? err.message : String(err);
		}
	}
	$effect(() => {
		const url = api;
		const hash = params.commit;
		if (url && hash && active) untrack(() => void loadFiles(url, hash));
	});
	const shownFiles = $derived(files && files.hash === params.commit ? files.files : null);

	let diff = $state<{ hash: string; diff: Diff } | null>(null);
	let diffError = $state<string | null>(null);
	let diffSeq = 0;
	async function loadDiff(url: string, hash: string, file: string) {
		const mine = ++diffSeq;
		try {
			const res = await fetch(`${url}/diff?${new URLSearchParams({ hash, file })}`);
			const body = await res.json();
			if (mine !== diffSeq) return;
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			diff = { hash, diff: body as Diff };
			diffError = null;
		} catch (err) {
			if (mine === diffSeq) diffError = err instanceof Error ? err.message : String(err);
		}
	}
	$effect(() => {
		const url = api;
		const hash = params.commit;
		const file = params.file;
		if (url && hash && file && active) untrack(() => void loadDiff(url, hash, file));
	});
	const shownDiff = $derived(
		diff && diff.hash === params.commit && diff.diff.file === params.file ? diff.diff : null
	);

	/** The file as the picked commit left it, for the lines its diff leaves out. */
	async function fileText(hash: string, file: string): Promise<string | null> {
		if (!api) return null;
		const res = await fetch(`${api}/file?${new URLSearchParams({ hash, file })}`);
		return res.ok ? ((await res.json()) as { text: string }).text : null;
	}

	function pick(hash: string) {
		setParams({ commit: hash, file: null }, { push: true });
	}

	function revealTurn(id: string) {
		window.dispatchEvent(new CustomEvent('claude-mux:reveal-entry', { detail: { id } }));
	}

	// ── header actions and keys ──────────────────────────────────────────

	$effect(() => {
		setActions([
			{
				icon: 'mdi:refresh',
				label: 'Reload',
				disabled: !api || loading,
				run: () => api && void loadList(api, graph)
			}
		]);
	});

	/** j/k step through the commits, unless someone is typing. */
	function onKey(e: KeyboardEvent) {
		if (!active || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key !== 'j' && e.key !== 'k') return;
		const el = e.target as HTMLElement | null;
		if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
		if (commits.length === 0) return;
		const at = picked ? commits.indexOf(picked) : -1;
		const next = commits[e.key === 'j' ? Math.min(at + 1, commits.length - 1) : Math.max(at - 1, 0)];
		e.preventDefault();
		setParams({ commit: next.hash, file: null });
		document.querySelector(`[data-commit="${next.hash}"]`)?.scrollIntoView({ block: 'nearest' });
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="history" class:picked={!!params.commit}>
	<div class="bar">
		<span class="branch">
			<iconify-icon icon="mdi:source-branch"></iconify-icon>
			{history?.branch ?? (history ? 'detached HEAD' : 'History')}
		</span>
		{#if unpushed > 0}
			<span class="chip local" title="Commits no remote branch has yet">{unpushed} to push</span>
		{/if}
		<span class="sp"></span>
		<div class="seg" role="group" aria-label="How the commits are shown">
			<Toggle size="sm" bind:pressed={() => !graph, (on) => on && setParams({ view: null })}
				title="The checked-out branch, by day">List</Toggle
			>
			<Toggle size="sm" bind:pressed={() => graph, (on) => on && setParams({ view: 'graph' })}
				title="Every worktree's branch and the upstream, a lane each">Graph</Toggle
			>
		</div>
	</div>

	{#if listError}
		<p class="msg err">{listError}</p>
	{:else if !history}
		<p class="msg">Loading…</p>
	{:else if commits.length === 0}
		<p class="msg">No commits yet.</p>
	{:else}
		<div class="split">
			<nav aria-label="Commits">
				{#each commits as commit, i (commit.hash)}
					{@const row = layout.rows[i]}
					{@const day = dayOf(commit.at, clock.now)}
					{#if !graph && (i === 0 || day !== dayOf(commits[i - 1].at, clock.now))}
						<div class="day" style:padding-left="{railWidth + 6}px">{day}</div>
					{/if}
					<button
						type="button"
						class="commit"
						class:on={commit.hash === params.commit}
						aria-current={commit.hash === params.commit ? 'true' : undefined}
						data-commit={commit.hash}
						onclick={() => pick(commit.hash)}
					>
						<svg class="rail" width={railWidth} height={ROW} viewBox="0 0 {railWidth} {ROW}" aria-hidden="true">
							{#each row.through as lane (lane)}
								<path d="M{laneX(lane)} 0 L{laneX(lane)} {ROW}" stroke={laneColor(lane)} />
							{/each}
							{#each row.into as lane (lane)}
								<path d={bend(lane, row, true)} stroke={laneColor(lane)} />
							{/each}
							{#each row.out as lane (lane)}
								<path d={bend(lane, row, false)} stroke={laneColor(lane)} />
							{/each}
							{#if commit.refs.some((r) => r.startsWith('tag: '))}
								<rect
									class="dot tag"
									x={laneX(row.lane) - 4}
									y={ROW / 2 - 4}
									width="8"
									height="8"
									transform="rotate(45 {laneX(row.lane)} {ROW / 2})"
								/>
							{:else}
								<circle
									class="dot"
									class:mine={commit.mine}
									cx={laneX(row.lane)}
									cy={ROW / 2}
									r="4"
									stroke={commit.mine ? undefined : laneColor(row.lane)}
								/>
							{/if}
						</svg>
						<span class="what">
							<span class="subject">{commit.subject}</span>
							<span class="meta">
								<span>{shortHash(commit.hash)}</span>
								<span>{formatAgo(commit.at, clock.now)}</span>
								{#each commit.refs as ref (ref)}
									{@const r = readRef(ref, branches)}
									{@const worker = r.kind === 'branch' ? workerOn(r.name) : null}
									<span class="chip {worker ? 'worker' : r.kind}" title={worker ? `${r.name}, where this worker runs` : ref}
										>{worker ?? r.name}</span
									>
								{/each}
								{#if commit.mine}<span class="chip mine" title="Made by this session">this session</span>{/if}
								{#if !commit.pushed}<span class="chip local" title="No remote branch has this commit yet">local</span>{/if}
							</span>
						</span>
						{#if commit.additions || commit.deletions}
							<span class="nums"><span class="add">+{commit.additions}</span> <span class="del">−{commit.deletions}</span></span>
						{/if}
					</button>
				{/each}
				{#if history.truncated}
					<p class="more">Older commits are not listed.</p>
				{/if}
			</nav>

			<section class="detail" aria-label="Commit">
				{#if picked}
					<div class="head">
						<button type="button" class="back" aria-label="Back to commits" onclick={() => setParams({ commit: null, file: null })}>
							<iconify-icon icon="mdi:arrow-left"></iconify-icon>
						</button>
						<div class="title">
							<h3>{picked.subject}</h3>
							<p class="who">
								<span>{shortHash(picked.hash)}</span>
								<span>{picked.author}</span>
								<span>{new Date(picked.at).toLocaleString()}</span>
							</p>
						</div>
					</div>
					<div class="acts">
						<button type="button" class="act" onclick={() => mention(shortHash(picked.hash))}>
							<iconify-icon icon="mdi:at"></iconify-icon> Add to chat
						</button>
						<button type="button" class="act" onclick={() => void copyWithToast(picked.hash, 'Hash copied')}>
							<iconify-icon icon="mdi:content-copy"></iconify-icon> Copy hash
						</button>
						{#if picked.turn}
							{@const turn = picked.turn}
							<button type="button" class="act" title="Show the turn of the conversation that made this commit" onclick={() => revealTurn(turn)}>
								<iconify-icon icon="mdi:message-arrow-left-outline"></iconify-icon> Go to turn
							</button>
						{/if}
					</div>
					{#if filesError}
						<p class="msg err">{filesError}</p>
					{:else if !shownFiles}
						<p class="msg">Loading…</p>
					{:else if shownFiles.length === 0}
						<p class="msg">This commit changed no files.</p>
					{:else}
						<div class="files">
							{#each shownFiles as f (f.file)}
								{@const open = f.file === params.file}
								<!-- The way to the Files pane rides on the file's own row, so it costs the diff no height. -->
								<div class="filerow" class:on={open}>
									<button
										type="button"
										class="file"
										aria-expanded={open}
										title={f.oldPath ? `${f.oldPath} → ${f.file}` : f.file}
										onclick={() => setParams({ file: open ? null : f.file })}
									>
										<span class="st {f.kind}">{statusLetter(f)}</span>
										<span class="path"><bdi>{f.file}</bdi></span>
										{#if f.binary}
											<span class="dim">bin</span>
										{:else}
											<span class="nums"><span class="add">+{f.additions}</span> <span class="del">−{f.deletions}</span></span>
										{/if}
									</button>
									{#if f.kind !== 'deleted'}
										<button
											type="button"
											class="tofiles"
											title="Open in Files, as the file is on disk now"
											aria-label="Open {f.file} in Files"
											onclick={() => openPane('files', { file: f.file, line: null })}
										>
											<iconify-icon icon="mdi:file-tree-outline"></iconify-icon>
										</button>
									{/if}
								</div>
								{#if open}
									<div class="diff">
										{#if diffError}
											<p class="msg err">{diffError}</p>
										{:else if !shownDiff}
											<p class="msg">Loading…</p>
										{:else if shownDiff.binary}
											<p class="msg">Binary file; no text diff.</p>
										{:else if shownDiff.hunks.length === 0}
											<p class="msg">No line changes.</p>
										{:else}
											{#key `${picked.hash}\0${f.file}`}
												<DiffLines
													hunks={shownDiff.hunks}
													file={f.file}
													loadText={f.kind === 'deleted' ? undefined : () => fileText(picked.hash, f.file)}
												/>
											{/key}
										{/if}
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				{:else}
					<p class="msg">Pick a commit to see what it changed.</p>
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	.history {
		height: 100%;
		display: flex;
		flex-direction: column;
		container-type: inline-size;
		font-size: 13px;
		color: #d6d3d1;
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
	.branch {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 12.5px;
		font-weight: 600;
		color: #e7e5e4;
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
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 4px 0 12px;
	}
	.picked nav {
		flex: none;
		width: min(24rem, 46%);
		border-right: 1px solid #222;
	}
	.day {
		padding: 10px 12px 2px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #78716c;
	}
	.commit {
		display: flex;
		align-items: center;
		width: 100%;
		height: 44px;
		padding: 0 12px 0 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.commit:hover {
		background: #171717;
	}
	.commit.on {
		background: #1f1f1f;
	}
	.commit:focus-visible,
	.file:focus-visible,
	.act:focus-visible,
	.tofiles:focus-visible,
	.back:focus-visible {
		outline: 2px solid #7dd3fc;
		outline-offset: -2px;
	}
	.rail {
		flex: none;
	}
	.rail path {
		fill: none;
		stroke-width: 2;
	}
	.dot {
		fill: #111111;
		stroke-width: 2;
	}
	.dot.mine {
		fill: #2dd4bf;
		stroke: #2dd4bf;
	}
	.dot.tag {
		stroke: #fbbf24;
	}
	.what {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.subject {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #e7e5e4;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		overflow: hidden;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #78716c;
	}
	.chip {
		flex: none;
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 0 5px;
		border: 1px solid #3a3532;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		line-height: 1.5;
		color: #a8a29e;
	}
	.chip.tag {
		color: #fbbf24;
		border-color: #6b5312;
	}
	.chip.remote {
		color: #7dd3fc;
		border-color: #1e4a5f;
	}
	.chip.mine {
		color: #2dd4bf;
		border-color: #14524a;
	}
	.chip.worker {
		color: #a78bfa;
		border-color: #4a3c7a;
	}
	.chip.local {
		color: #fdba74;
		border-color: #6b3d12;
	}
	.nums {
		flex: none;
		padding-left: 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		white-space: nowrap;
	}
	.add {
		color: #3f9d63;
	}
	.del {
		color: #b4565a;
	}
	.more {
		margin: 0;
		padding: 10px 14px;
		font-size: 11.5px;
		color: #78716c;
	}

	.detail {
		flex: 1;
		min-width: 0;
		display: none;
		flex-direction: column;
		overflow-y: auto;
	}
	.picked .detail {
		display: flex;
	}
	.head {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		padding: 12px 14px 0;
	}
	.back {
		display: none;
		flex: none;
		width: 40px;
		height: 40px;
		margin: -8px 0 0 -10px;
		align-items: center;
		justify-content: center;
		border: 0;
		background: none;
		color: #a8a29e;
		font-size: 18px;
		cursor: pointer;
	}
	.title {
		min-width: 0;
	}
	h3 {
		margin: 0;
		font-size: 14.5px;
		font-weight: 600;
		line-height: 1.35;
		color: #f5f5f4;
		overflow-wrap: anywhere;
	}
	.who {
		margin: 4px 0 0;
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: #a8a29e;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 10px 14px 12px;
		border-bottom: 1px solid #222;
	}
	.act {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid #2a2a2a;
		border-radius: 7px;
		background: #1a1a1a;
		color: #e7e5e4;
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.act:hover {
		background: #232323;
	}
	.files {
		display: flex;
		flex-direction: column;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.filerow {
		display: flex;
		align-items: stretch;
		border-bottom: 1px solid #1c1c1c;
	}
	.filerow:hover {
		background: #171717;
	}
	.filerow.on {
		background: #1f1f1f;
	}
	.filerow.on .file {
		color: #f5f5f4;
	}
	.tofiles {
		flex: none;
		width: 36px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		background: transparent;
		color: #78716c;
		font-size: 15px;
		cursor: pointer;
		/* Out of the way until the row is the one in hand; always there where nothing hovers. */
		opacity: 0;
	}
	.filerow:hover .tofiles,
	.filerow.on .tofiles,
	.tofiles:focus-visible {
		opacity: 1;
	}
	.tofiles:hover {
		color: #f5f5f4;
	}
	.file {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		min-height: 34px;
		padding: 0 4px 0 14px;
		border: 0;
		background: transparent;
		color: #d6d3d1;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.st {
		flex: none;
		width: 1ch;
		font-weight: 600;
		color: #fbbf24;
	}
	.st.added {
		color: #4ade80;
	}
	.st.deleted {
		color: #f87171;
	}
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		direction: rtl;
		text-align: left;
	}
	.dim {
		color: #78716c;
	}
	.diff {
		display: flex;
		flex-direction: column;
		max-height: 70vh;
		border-bottom: 1px solid #222;
	}

	/* Too narrow for both: the commits, or the picked one with a way back. */
	@container (max-width: 38rem) {
		.picked nav {
			display: none;
		}
		.back {
			display: inline-flex;
		}
	}
	@media (pointer: coarse) {
		.seg :global([data-slot='toggle']) {
			height: 40px;
		}
		.act {
			height: 38px;
		}
		.file {
			min-height: 42px;
		}
		.tofiles {
			width: 44px;
			opacity: 1;
		}
	}
</style>
