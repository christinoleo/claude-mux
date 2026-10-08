<script lang="ts">
	/**
	 * The session's project, read-only: a tree on the left, the open file on
	 * the right. With no file open the tree takes the whole pane; once one is,
	 * the tree narrows to a column docked inside the viewer, and on a narrow
	 * pane the two take turns.
	 *
	 * The URL holds the file (`file`, relative to the project root) and the
	 * line to show (`line`). Which directories are open, the last file, and
	 * whether ignored entries are listed persist per session. Shiki loads the
	 * first time a file is drawn.
	 */
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { ThemedToken } from 'shiki/core';
	import type { PaneBodyProps } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import { Input } from '$lib/components/ui/input';
	import {
		ancestors,
		fuzzyFilter,
		isMarkdown,
		shikiLanguage,
		type DirListing,
		type FileEntry,
		type FileRead
	} from '$lib/side-panel/files';
	import { displayPath } from '$lib/side-panel/changes';
	import { highlightFile } from '$lib/side-panel/shiki';
	import { renderMarkdown } from '$lib/markdown';
	import { filesPaneStore } from '$lib/stores/filesPane.svelte';

	let { session, params, setParams, setActions, mention, active }: PaneBodyProps = $props();

	const sessionId = $derived(session?.id ?? null);
	const api = $derived(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/files` : null);
	const prefs = $derived(filesPaneStore.get(sessionId));
	const showIgnored = $derived(prefs.showIgnored === true);
	// Only paths inside the root belong here; an older build could save others.
	const expanded = $derived(new Set((prefs.expanded ?? []).filter((d) => d && !d.startsWith('/'))));

	// ── the tree ─────────────────────────────────────────────────────────

	type DirState = DirListing | { error: string } | 'loading';
	let dirs = $state<Record<string, DirState>>({});
	/** Bumped by a reload or the ignored toggle, so answers for the old tree are dropped. */
	let treeEpoch = 0;

	async function loadDir(dir: string) {
		if (!api) return;
		const epoch = treeEpoch;
		dirs[dir] = 'loading';
		const q = new URLSearchParams({ dir });
		if (showIgnored) q.set('ignored', '1');
		try {
			const res = await fetch(`${api}/tree?${q}`);
			const body = await res.json();
			if (epoch !== treeEpoch) return;
			dirs[dir] = res.ok ? (body as DirListing) : { error: body.error ?? `HTTP ${res.status}` };
		} catch (err) {
			if (epoch === treeEpoch) dirs[dir] = { error: err instanceof Error ? err.message : String(err) };
		}
	}

	function reloadTree() {
		treeEpoch++;
		dirs = {};
		void loadDir('');
		for (const dir of expanded) void loadDir(dir);
	}

	const rootListing = $derived.by(() => {
		const r = dirs[''];
		return r && r !== 'loading' && 'entries' in r ? r : null;
	});
	const root = $derived(rootListing?.root ?? null);
	const repo = $derived(rootListing?.repo ?? false);

	/** What the tree was last read for; showing the pane again reuses it, Reload reads it afresh. */
	let readFor: string | null = null;
	$effect(() => {
		const key = `${api}\0${showIgnored}`;
		if (!active || !api || key === readFor) return;
		readFor = key;
		untrack(reloadTree);
	});

	function setExpanded(dir: string, open: boolean) {
		const next = new Set(expanded);
		if (open) next.add(dir);
		else next.delete(dir);
		filesPaneStore.update(sessionId, { expanded: [...next] });
		if (open && !dirs[dir]) void loadDir(dir);
	}

	function toggleIgnored() {
		filesPaneStore.update(sessionId, { showIgnored: !showIgnored });
	}

	// ── the open file ────────────────────────────────────────────────────

	/** The file the URL names, made relative when it is an absolute path inside the root. */
	const wantedFile = $derived(params.file ? displayPath(params.file, root) : null);
	const wantedLine = $derived.by(() => {
		const n = Number(params.line);
		return Number.isInteger(n) && n > 0 ? n : null;
	});

	// No file in the URL: reopen the one last open here.
	let restored = false;
	$effect(() => {
		if (!active || restored) return;
		restored = true;
		const last = untrack(() => prefs.file);
		if (!params.file && last) setParams({ file: last });
	});

	type Shown = { path: string; read: FileRead } | { path: string; error: string; binary?: boolean };
	let shown = $state<Shown | null>(null);
	let fileSeq = 0;

	async function loadFile(path: string) {
		if (!api) return;
		const mine = ++fileSeq;
		try {
			const res = await fetch(`${api}/read?${new URLSearchParams({ path })}`);
			const body = await res.json();
			if (mine !== fileSeq) return;
			if (!res.ok) {
				shown = { path, error: body.error ?? `HTTP ${res.status}`, binary: body.binary === true };
				return;
			}
			const read = body as FileRead;
			shown = { path, read };
			// An absolute or roundabout spelling settles on the path inside the root.
			if (read.path !== path) {
				fileReadFor = `${read.path}\0${params.line ?? ''}`;
				setParams({ file: read.path });
			}
			revealInTree(read.path);
			filesPaneStore.update(sessionId, { file: read.path });
		} catch (err) {
			if (mine === fileSeq) shown = { path, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * What the file was last read for: its path and the line asked. A link
	 * that names the open file again (after Claude edited it, say) reads it
	 * afresh rather than scrolling stale text; showing the pane again does not.
	 */
	let fileReadFor: string | null = null;
	$effect(() => {
		const path = wantedFile;
		if (!path || !active) return;
		const key = `${path}\0${params.line ?? ''}`;
		if (key === fileReadFor) return;
		fileReadFor = key;
		untrack(() => void loadFile(path));
	});

	/** Open the directories that hold `path` (inside the root), so the tree shows where it is. */
	function revealInTree(path: string) {
		const missing = ancestors(path).filter((d) => !expanded.has(d));
		if (missing.length === 0) return;
		filesPaneStore.update(sessionId, { expanded: [...expanded, ...missing] });
		for (const d of missing) if (!dirs[d]) void loadDir(d);
	}

	const current = $derived(
		shown && wantedFile && (shown.path === wantedFile || ('read' in shown && shown.read.path === wantedFile))
			? shown
			: null
	);
	const read = $derived(current && 'read' in current ? current.read : null);
	const openPath = $derived(read?.path ?? wantedFile);

	function openFile(path: string, line?: number) {
		setParams({ file: path, line: line ? String(line) : null }, { push: true });
	}

	function closeFile() {
		filesPaneStore.update(sessionId, { file: undefined });
		setParams({ file: null, line: null });
	}

	/** Markdown opens rendered; this flips the open file to its source. */
	let mdSource = $state(false);
	const markdown = $derived(read?.kind === 'text' && isMarkdown(read.path));
	const rendered = $derived(markdown && !mdSource && wantedLine === null);

	const lines = $derived(read?.kind === 'text' ? read.text.replace(/\n$/, '').split('\n') : []);
	let tokens = $state<ThemedToken[][] | null>(null);
	$effect(() => {
		tokens = null;
		if (read?.kind !== 'text' || rendered) return;
		const { text, path } = read;
		let stale = false;
		void highlightFile(text, shikiLanguage(path)).then((t) => {
			if (!stale) tokens = t;
		});
		return () => (stale = true);
	});

	/** Lines are drawn in blocks the browser may skip laying out while off screen. */
	const CHUNK = 200;
	const chunks = $derived(
		Array.from({ length: Math.ceil(lines.length / CHUNK) }, (_, i) => i * CHUNK)
	);

	let codeEl = $state<HTMLElement | null>(null);
	$effect(() => {
		const line = wantedLine;
		if (!line || !codeEl || lines.length === 0) return;
		void tokens;
		requestAnimationFrame(() =>
			codeEl?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' })
		);
	});

	function pickLine(n: number) {
		setParams({ line: wantedLine === n ? null : String(n) });
	}

	async function copyPath() {
		if (!openPath) return;
		const text = wantedLine ? `${openPath}:${wantedLine}` : openPath;
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Path copied', { description: text });
		} catch {
			toast.error('Could not copy the path');
		}
	}

	/**
	 * Claude Code reads an `@path` from the session's cwd, which may sit below
	 * the root this pane lists from: the path is made relative to the cwd, or
	 * left absolute when the cwd is not inside the root.
	 */
	function mentionOpen() {
		if (!openPath || !root) return;
		const abs = `${root}/${openPath}`;
		const cwd = session?.cwd ?? root;
		mention(`@${cwd === root ? openPath : displayPath(abs, cwd)}`);
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	// ── quick open ───────────────────────────────────────────────────────

	let query = $state('');
	let allFiles = $state<string[] | null>(null);
	let listError = $state<string | null>(null);
	let listing = false;
	let picked = $state(0);

	async function loadAll() {
		if (allFiles || listing || !api) return;
		listing = true;
		listError = null;
		try {
			const res = await fetch(`${api}/list`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			allFiles = (body as { files: string[] }).files;
		} catch (err) {
			listError = err instanceof Error ? err.message : String(err);
		} finally {
			listing = false;
		}
	}

	const results = $derived(query.trim() && allFiles ? fuzzyFilter(query, allFiles) : []);
	$effect(() => {
		void results;
		picked = 0;
	});

	function openResult(path: string) {
		query = '';
		openFile(path);
	}

	function onQueryKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const n = results.length;
			if (n) picked = (picked + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
			document.querySelector(`[data-result="${picked}"]`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter' && results[picked]) {
			e.preventDefault();
			openResult(results[picked]);
		} else if (e.key === 'Escape' && query) {
			e.preventDefault();
			e.stopPropagation();
			query = '';
		}
	}

	// ── header actions ───────────────────────────────────────────────────

	$effect(() => {
		setActions([
			...(repo
				? [
						{
							icon: showIgnored ? 'mdi:eye-outline' : 'mdi:eye-off-outline',
							label: showIgnored ? 'Hide ignored files' : 'Show ignored files',
							pressed: showIgnored,
							run: toggleIgnored
						}
					]
				: []),
			{
				icon: 'mdi:refresh',
				label: 'Reload',
				disabled: !sessionId,
				run: () => {
					allFiles = null;
					if (query.trim()) void loadAll();
					reloadTree();
					if (wantedFile) void loadFile(wantedFile);
				}
			}
		]);
	});
</script>

{#snippet tree(dir: string, depth: number)}
	{@const d = dirs[dir]}
	{#if d === 'loading' || d === undefined}
		<div class="note" style:--depth={depth}>Loading…</div>
	{:else if 'error' in d}
		<div class="note err" style:--depth={depth}>{d.error}</div>
	{:else}
		{#each d.entries as entry (entry.path)}
			{@render node(entry, depth)}
		{/each}
		{#if d.entries.length === 0}
			<div class="note" style:--depth={depth}>{d.hidden ? `${d.hidden} ignored` : 'Empty'}</div>
		{/if}
	{/if}
{/snippet}

{#snippet node(entry: FileEntry, depth: number)}
	{#if entry.type === 'dir'}
		{@const open = expanded.has(entry.path)}
		<button
			type="button"
			class="item dir"
			class:ignored={entry.ignored}
			style:--depth={depth}
			aria-expanded={open}
			title={entry.path}
			onclick={() => setExpanded(entry.path, !open)}
		>
			<iconify-icon class="chev" class:open icon="mdi:chevron-right"></iconify-icon>
			<iconify-icon class="ico" icon={open ? 'mdi:folder-open-outline' : 'mdi:folder-outline'}></iconify-icon>
			<span class="name">{entry.name}</span>
			{#if entry.link}<iconify-icon class="link" icon="mdi:link-variant"></iconify-icon>{/if}
		</button>
		{#if open}{@render tree(entry.path, depth + 1)}{/if}
	{:else}
		<button
			type="button"
			class="item file"
			class:ignored={entry.ignored}
			class:on={openPath === entry.path}
			aria-current={openPath === entry.path ? 'true' : undefined}
			style:--depth={depth}
			title={entry.path}
			onclick={() => openFile(entry.path)}
		>
			<span class="chev"></span>
			<iconify-icon class="ico" icon="mdi:file-outline"></iconify-icon>
			<span class="name">{entry.name}</span>
			{#if entry.link}<iconify-icon class="link" icon="mdi:link-variant"></iconify-icon>{/if}
		</button>
	{/if}
{/snippet}

<div class="files" class:picked={!!wantedFile}>
	<nav aria-label="Project files">
		{#if repo}
			<div class="search">
				<iconify-icon icon="mdi:magnify"></iconify-icon>
				<Input
					bind:value={query}
					type="search"
					placeholder="Go to file…"
					aria-label="Go to file"
					autocomplete="off"
					spellcheck={false}
					onfocus={loadAll}
					onkeydown={onQueryKey}
				/>
			</div>
		{/if}
		<div class="list">
			{#if query.trim()}
				{#if listError}
					<div class="note err">{listError}</div>
				{:else if !allFiles}
					<div class="note">Loading…</div>
				{:else if results.length === 0}
					<div class="note">No file matches.</div>
				{:else}
					{#each results as path, i (path)}
						<button
							type="button"
							class="item result"
							class:on={i === picked}
							data-result={i}
							title={path}
							onclick={() => openResult(path)}
						>
							<span class="name">{path.split('/').pop()}</span>
							<span class="dirname"><bdi>{path.split('/').slice(0, -1).join('/')}</bdi></span>
						</button>
					{/each}
				{/if}
			{:else}
				{#if root}
					<div class="root" title={root}>{root.split('/').pop() || root}</div>
				{/if}
				{@render tree('', 0)}
				{#if rootListing && !showIgnored && rootListing.hidden > 0}
					<button type="button" class="more" onclick={toggleIgnored}>
						+ {rootListing.hidden} ignored at the top level (show)
					</button>
				{/if}
			{/if}
		</div>
	</nav>

	{#if wantedFile}
		<section class="viewer" aria-label="File">
			<div class="vhead">
				<button type="button" class="icon back" aria-label="Back to files" onclick={closeFile}>
					<iconify-icon icon="mdi:arrow-left"></iconify-icon>
				</button>
				<span class="path" title={openPath}><bdi>{openPath}</bdi></span>
				{#if read}<span class="dim size">{formatSize(read.size)}</span>{/if}
				{#if markdown}
					<div class="seg" role="group" aria-label="Markdown view">
						<Toggle
							size="sm"
							bind:pressed={() => rendered, (on) => {
								if (on) {
									mdSource = false;
									setParams({ line: null });
								}
							}}>Preview</Toggle
						>
						<Toggle size="sm" bind:pressed={() => !rendered, (on) => on && (mdSource = true)}>Source</Toggle>
					</div>
				{/if}
				<button type="button" class="icon" title="Copy path" aria-label="Copy path" onclick={copyPath}>
					<iconify-icon icon="mdi:content-copy"></iconify-icon>
				</button>
				<button
					type="button"
					class="icon"
					title="Mention in composer"
					aria-label="Mention in composer"
					onclick={mentionOpen}
				>
					<iconify-icon icon="mdi:at"></iconify-icon>
				</button>
				<button type="button" class="icon wide-only" title="Close file" aria-label="Close file" onclick={closeFile}>
					<iconify-icon icon="mdi:close"></iconify-icon>
				</button>
			</div>
			{#if read?.kind === 'text' && read.truncated}
				<div class="banner">Truncated at 1 MB: showing the first {formatSize(read.shown)} of {formatSize(read.size)}.</div>
			{/if}
			{#if !current}
				<p class="msg">Loading…</p>
			{:else if 'error' in current}
				<p class="msg" class:err={!current.binary}>
					{current.binary ? 'Binary file; not shown.' : current.error}
				</p>
			{:else if read?.kind === 'image'}
				<div class="image">
					<img src="{api}/read?{new URLSearchParams({ path: read.path, raw: '1' })}" alt={read.path} />
				</div>
			{:else if rendered && read?.kind === 'text'}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped -->
				<div class="md markdown">{@html renderMarkdown(read.text)}</div>
			{:else if lines.length === 0}
				<p class="msg">Empty file.</p>
			{:else}
				<div class="code" bind:this={codeEl} style:--gutter="{String(lines.length).length + 1}ch">
					{#each chunks as start (start)}
						<div class="chunk" style:--rows={Math.min(CHUNK, lines.length - start)}>
							{#each lines.slice(start, start + CHUNK) as text, j (j)}
								{@const n = start + j + 1}
								<div class="ln" class:hl={wantedLine === n} data-line={n}>
									<button type="button" class="no" tabindex="-1" onclick={() => pickLine(n)}>{n}</button>
									<span class="src"
										>{#if tokens?.[n - 1]}{#each tokens[n - 1] as t, k (k)}<span style:color={t.color}
													>{t.content}</span
												>{/each}{:else}{text}{/if}</span
									>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.files {
		height: 100%;
		display: flex;
		container-type: inline-size;
		font-size: 13px;
		color: #d6d3d1;
	}
	nav {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.picked nav {
		flex: none;
		width: min(22rem, 46%);
		border-right: 1px solid #222;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 10px;
		border-bottom: 1px solid #222;
		color: #78716c;
		flex: none;
	}
	.search :global(input) {
		height: 32px;
		font-family: var(--font-mono);
		font-size: 12px;
		background: #1a1a1a;
		border-color: #2a2a2a;
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 6px 6px 16px;
	}
	.root {
		padding: 4px 8px 6px;
		color: #78716c;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		min-height: 28px;
		padding: 0 8px 0 calc(4px + var(--depth, 0) * 14px);
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #d6d3d1;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.item:hover {
		background: #1a1a1a;
	}
	.item.on {
		background: #1f1f1f;
		color: #f5f5f4;
	}
	.item.ignored {
		color: #6b6560;
	}
	.chev {
		flex: none;
		width: 14px;
		color: #78716c;
		transition: transform 0.12s;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.ico {
		flex: none;
		color: #a8a29e;
		font-size: 14px;
	}
	.dir .ico {
		color: #93c5fd;
	}
	.ignored .ico {
		color: inherit;
		opacity: 0.6;
	}
	.link {
		flex: none;
		color: #78716c;
		font-size: 12px;
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.result {
		gap: 10px;
		padding-left: 8px;
	}
	.result .name {
		flex: none;
		max-width: 60%;
	}
	.dirname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		direction: rtl;
		text-align: left;
		color: #78716c;
	}
	.note {
		padding: 5px 8px 5px calc(26px + var(--depth, 0) * 14px);
		color: #78716c;
	}
	.err {
		color: #f87171;
	}
	.more {
		border: 0;
		background: none;
		padding: 9px 8px 4px;
		min-height: 32px;
		color: #78716c;
		font: inherit;
		font-size: 11.5px;
		cursor: pointer;
		text-align: left;
	}
	.more:hover {
		color: #d6d3d1;
	}
	.viewer {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.vhead {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 6px 8px 6px 14px;
		border-bottom: 1px solid #222;
		flex: none;
	}
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		direction: rtl;
		text-align: left;
		font-family: var(--font-mono);
		font-size: 12px;
		color: #e7e5e4;
	}
	.dim {
		color: #78716c;
	}
	.size {
		flex: none;
		font-size: 11.5px;
	}
	.icon {
		flex: none;
		width: 30px;
		height: 30px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: #a8a29e;
		font-size: 15px;
		cursor: pointer;
	}
	.icon:hover {
		background: #1f1f1f;
		color: #f5f5f4;
	}
	.back {
		display: none;
		margin-left: -8px;
	}
	.seg {
		flex: none;
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: 8px;
		border: 1px solid #2a2a2a;
		background: #1a1a1a;
	}
	.seg :global([data-slot='toggle']) {
		color: #a8a29e;
		height: 26px;
		font-size: 12px;
	}
	.seg :global([data-slot='toggle'][data-state='on']) {
		background: #e7e5e4;
		color: #0b0b0b;
	}
	.banner {
		flex: none;
		padding: 6px 14px;
		background: #2a2110;
		color: #fcd34d;
		font-size: 12px;
		border-bottom: 1px solid #3a2e14;
	}
	.msg {
		margin: 0;
		padding: 16px 18px;
		color: #78716c;
	}
	.msg.err {
		color: #f87171;
	}
	.image {
		flex: 1;
		overflow: auto;
		padding: 16px;
		background:
			repeating-conic-gradient(#161616 0 25%, #1c1c1c 0 50%) 0 0 / 16px 16px;
	}
	.image img {
		max-width: 100%;
		height: auto;
		display: block;
		margin: 0 auto;
	}
	.md {
		flex: 1;
		overflow: auto;
		padding: 16px 20px 32px;
		font-size: 14px;
		line-height: 1.6;
	}
	/* A document, not a reply: its headings stand out more than the transcript's. */
	.md :global(h1) {
		font-size: 1.45em;
		margin-top: 4px;
	}
	.md :global(h2) {
		font-size: 1.2em;
		margin-top: 20px;
	}
	.md :global(h3) {
		font-size: 1.05em;
	}
	.code {
		flex: 1;
		overflow: auto;
		padding: 6px 0 24px;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.65;
	}
	.chunk {
		width: max-content;
		min-width: 100%;
		content-visibility: auto;
		contain-intrinsic-size: auto calc(var(--rows) * 1.65em);
	}
	.ln {
		display: flex;
		color: #c9d1d9;
	}
	.ln.hl {
		background: #2a2a1a;
	}
	.no {
		flex: none;
		width: calc(var(--gutter) + 1ch);
		padding: 0 1.5ch 0 0;
		border: 0;
		background: none;
		text-align: right;
		color: #57534e;
		font: inherit;
		cursor: pointer;
		user-select: none;
	}
	.no:hover,
	.hl .no {
		color: #d6d3d1;
	}
	.src {
		white-space: pre;
		padding-right: 14px;
	}

	/* Too narrow for both: the tree, or the open file with a way back. */
	@container (max-width: 38rem) {
		.picked nav {
			display: none;
		}
		.back {
			display: inline-flex;
		}
		.wide-only {
			display: none;
		}
	}
	@media (pointer: coarse) {
		.item,
		.more {
			min-height: 40px;
		}
		.icon {
			width: 40px;
			height: 40px;
		}
	}
</style>
