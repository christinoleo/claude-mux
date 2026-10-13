<script lang="ts">
	/**
	 * The session's project, read-only. With no file open the tree takes the
	 * whole pane; once one is, the file has the pane and the tree narrows to a
	 * column on its far side, which a button in the file's header puts away
	 * and brings back. On a narrow pane the two take turns instead. The
	 * arrangement and its measures follow t3code's FilePreviewPanel
	 * (https://github.com/pingdotgg/t3code, MIT, © T3 Tools Inc.).
	 *
	 * The URL holds the file (`file`, relative to the project root) and the
	 * line to show (`line`). Which directories are open, the last file, and
	 * whether ignored entries are listed persist per session. Shiki loads the
	 * first time a file is drawn.
	 */
	import { untrack } from 'svelte';
	import type { ThemedToken } from 'shiki/core';
	import type { PaneBodyProps } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as Popover from '$lib/components/ui/popover';
	import { Input } from '$lib/components/ui/input';
	import {
		ancestors,
		baseName,
		fuzzyFilter,
		isMarkdown,
		parentOf,
		shikiLanguage,
		type DirListing,
		type FileEntry,
		type FileRead
	} from '$lib/side-panel/files';
	import { displayPath } from '$lib/side-panel/changes';
	import { highlightFile } from '$lib/side-panel/shiki';
	import { renderMarkdown } from '$lib/markdown';
	import { filesPaneStore } from '$lib/stores/filesPane.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { copyWithToast } from '$lib/side-panel/clipboard';

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

	/** A directory's entries, once they have been read. */
	function listingOf(dir: string): DirListing | null {
		const d = dirs[dir];
		return d && d !== 'loading' && 'entries' in d ? d : null;
	}
	const rootListing = $derived(listingOf(''));
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

	/** Enough to open any project worth reading as a tree, and a stop for one that is not. */
	const EXPAND_ALL_DIRS = 400;

	/**
	 * Open every directory, a level at a time. Ignored directories and links
	 * stay shut: `node_modules` is nobody's idea of "everything", and a link
	 * can lead back up the tree.
	 */
	async function expandAll() {
		const open: string[] = [];
		let level = [''];
		while (level.length > 0 && open.length < EXPAND_ALL_DIRS) {
			const next: string[] = [];
			// All at once: the browser already holds a host to a few requests at a time.
			await Promise.all(level.filter((dir) => !listingOf(dir)).map(loadDir));
			for (const dir of level) {
				for (const entry of listingOf(dir)?.entries ?? []) {
					if (entry.type === 'dir' && !entry.ignored && !entry.link) next.push(entry.path);
				}
			}
			open.push(...next);
			level = next;
		}
		filesPaneStore.update(sessionId, { expanded: open.slice(0, EXPAND_ALL_DIRS) });
	}

	function collapseAll() {
		filesPaneStore.update(sessionId, { expanded: [] });
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

	const copyText = (text: string) => copyWithToast(text, 'Path copied');

	function copyPath() {
		if (openPath) void copyText(wantedLine ? `${openPath}:${wantedLine}` : openPath);
	}

	/**
	 * How Claude Code is told about a path. It reads an `@path` from the
	 * session's cwd, which may sit below the root this pane lists from: the
	 * path is made relative to the cwd, or left absolute when the cwd is not
	 * inside the root.
	 */
	function mentionOf(path: string): string | null {
		if (!root) return null;
		const cwd = session?.cwd ?? root;
		return `@${cwd === root ? path : displayPath(`${root}/${path}`, cwd)}`;
	}

	function mentionPath(path: string | null) {
		const text = path && mentionOf(path);
		if (text) mention(text);
	}

	// ── a row's own menu, and dragging it to the composer ────────────────

	/** The row the context menu was opened on; one menu serves the whole tree. */
	let menuEntry = $state<{ path: string; dir: boolean } | null>(null);

	/** Right-clicking the list between rows is the browser's business, not ours. */
	function onListContextMenu(e: MouseEvent) {
		const row = (e.target as Element | null)?.closest<HTMLElement>('[data-path]');
		const path = row?.dataset.path;
		if (!path) return e.stopPropagation();
		menuEntry = { path, dir: row.dataset.type === 'dir' };
	}

	/** Dropped on the composer, a row becomes a mention of it; anywhere else, its path. */
	function onRowDrag(e: DragEvent, path: string) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData('text/plain', `${mentionOf(path) ?? path} `);
		e.dataTransfer.effectAllowed = 'copy';
	}

	// ── the breadcrumb, which finds its way around without the tree ──────

	/** The crumb whose menu is open, and the directory that menu is showing. */
	let crumbFor = $state<string | null>(null);
	let browsing = $state('');

	function browse(dir: string) {
		browsing = dir;
		if (!dirs[dir]) void loadDir(dir);
	}

	const crumbs = $derived(openPath ? ancestors(openPath) : []);
	const rootName = $derived((root && baseName(root)) || 'root');
	const explorerLabel = $derived(preferences.fileExplorerOpen ? 'Hide file explorer' : 'Show file explorer');

	/** The file's own name is what was asked for, so the row of crumbs rests on it. */
	let crumbsEl = $state<HTMLElement | null>(null);
	$effect(() => {
		// Everything that changes how wide the row or its box is.
		void [openPath, rootName, read, markdown, preferences.fileExplorerOpen];
		const el = crumbsEl;
		// After the frame: the crumbs for the new path are not laid out yet.
		if (el) requestAnimationFrame(() => (el.scrollLeft = el.scrollWidth));
	});

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
			expanded.size > 0
				? { icon: 'mdi:unfold-less-horizontal', label: 'Collapse all folders', run: collapseAll }
				: { icon: 'mdi:unfold-more-horizontal', label: 'Expand all folders', run: () => void expandAll() },
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
			data-path={entry.path}
			data-type="dir"
			draggable="true"
			ondragstart={(e) => onRowDrag(e, entry.path)}
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
			data-path={entry.path}
			data-type="file"
			draggable="true"
			ondragstart={(e) => onRowDrag(e, entry.path)}
			onclick={() => openFile(entry.path)}
		>
			<span class="chev"></span>
			<iconify-icon class="ico" icon="mdi:file-outline"></iconify-icon>
			<span class="name">{entry.name}</span>
			{#if entry.link}<iconify-icon class="link" icon="mdi:link-variant"></iconify-icon>{/if}
		</button>
	{/if}
{/snippet}

<!-- A folder in the breadcrumb opens onto what it holds, and from there onto any folder below it. -->
{#snippet crumb(dir: string, label: string)}
	<Popover.Root
		bind:open={() => crumbFor === dir, (open) => {
			crumbFor = open ? dir : null;
			if (open) browse(dir);
		}}
	>
		<Popover.Trigger class="shrink-0 cursor-pointer rounded px-1 py-0.5 font-mono text-xs text-stone-400 hover:bg-[#1f1f1f] hover:text-stone-100">
			{label}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-64 max-w-[80vw] border-[#333] bg-[#1a1a1a] p-1">
			{@const listing = listingOf(browsing)}
			<div class="flex max-h-72 flex-col overflow-y-auto font-mono text-xs">
				{#if browsing !== dir}
					<button
						type="button"
						class="flex min-h-8 items-center gap-1.5 rounded px-2 text-left text-stone-400 hover:bg-[#262626]"
						onclick={() => browse(parentOf(browsing))}
					>
						<iconify-icon icon="mdi:arrow-left"></iconify-icon>
						Back to {baseName(parentOf(browsing)) || rootName}
					</button>
				{/if}
				{#if !listing}
					<div class="px-2 py-1.5 text-stone-500">
						{dirs[browsing] && dirs[browsing] !== 'loading' ? 'Could not read this folder' : 'Loading…'}
					</div>
				{:else}
					{#each listing.entries as entry (entry.path)}
						<button
							type="button"
							class="flex min-h-8 items-center gap-1.5 rounded px-2 text-left text-stone-200 hover:bg-[#262626] {entry.path ===
							openPath
								? 'bg-[#262626]'
								: ''} {entry.ignored ? 'text-stone-500' : ''}"
							onclick={() => {
								if (entry.type === 'dir') return browse(entry.path);
								crumbFor = null;
								openFile(entry.path);
							}}
						>
							<iconify-icon icon={entry.type === 'dir' ? 'mdi:folder-outline' : 'mdi:file-outline'}></iconify-icon>
							<span class="min-w-0 flex-1 truncate">{entry.name}</span>
							{#if entry.type === 'dir'}<iconify-icon icon="mdi:chevron-right"></iconify-icon>{/if}
						</button>
					{/each}
					{#if listing.entries.length === 0}
						<div class="px-2 py-1.5 text-stone-500">Empty</div>
					{/if}
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
{/snippet}

<div class="files" class:picked={!!wantedFile} class:tree-off={!preferences.fileExplorerOpen}>
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
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="list" oncontextmenucapture={onListContextMenu}>
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
							<span class="name">{baseName(path)}</span>
							<span class="dirname"><bdi>{parentOf(path)}</bdi></span>
						</button>
					{/each}
				{/if}
			{:else}
				{#if root}
					<div class="root" title={root}>{rootName}</div>
				{/if}
				<ContextMenu.Root>
					<ContextMenu.Trigger>{@render tree('', 0)}</ContextMenu.Trigger>
					<ContextMenu.Content class="min-w-44">
						{#if menuEntry}
							{@const entry = menuEntry}
							{#if !entry.dir}
								<ContextMenu.Item onSelect={() => openFile(entry.path)}>
									<iconify-icon icon="mdi:file-eye-outline"></iconify-icon>
									Open
								</ContextMenu.Item>
							{:else}
								<ContextMenu.Item onSelect={() => setExpanded(entry.path, !expanded.has(entry.path))}>
									<iconify-icon icon={expanded.has(entry.path) ? 'mdi:folder-outline' : 'mdi:folder-open-outline'}
									></iconify-icon>
									{expanded.has(entry.path) ? 'Collapse' : 'Expand'}
								</ContextMenu.Item>
							{/if}
							<ContextMenu.Item onSelect={() => mentionPath(entry.path)}>
								<iconify-icon icon="mdi:at"></iconify-icon>
								Add to chat
							</ContextMenu.Item>
							<ContextMenu.Separator />
							<ContextMenu.Item onSelect={() => void copyText(entry.path)}>
								<iconify-icon icon="mdi:content-copy"></iconify-icon>
								Copy path
							</ContextMenu.Item>
							{#if root}
								<ContextMenu.Item onSelect={() => void copyText(`${root}/${entry.path}`)}>
									<iconify-icon icon="mdi:content-copy"></iconify-icon>
									Copy absolute path
								</ContextMenu.Item>
							{/if}
						{/if}
					</ContextMenu.Content>
				</ContextMenu.Root>
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
				<div class="crumbs" bind:this={crumbsEl} title={openPath}>
					{@render crumb('', rootName)}
					{#each crumbs as dir (dir)}
						<iconify-icon class="sep" icon="mdi:chevron-right"></iconify-icon>
						{@render crumb(dir, baseName(dir))}
					{/each}
					<iconify-icon class="sep" icon="mdi:chevron-right"></iconify-icon>
					<span class="leaf">{openPath ? baseName(openPath) : ''}</span>
				</div>
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
					onclick={() => mentionPath(openPath)}
				>
					<iconify-icon icon="mdi:at"></iconify-icon>
				</button>
				{#if read?.kind === 'text' && !rendered}
					{@const wrapLabel = preferences.fileWordWrap ? 'Let long lines scroll' : 'Wrap long lines'}
					<button
						type="button"
						class="icon"
						class:on={preferences.fileWordWrap}
						aria-pressed={preferences.fileWordWrap}
						title={wrapLabel}
						aria-label={wrapLabel}
						onclick={() => (preferences.fileWordWrap = !preferences.fileWordWrap)}
					>
						<iconify-icon icon="mdi:wrap"></iconify-icon>
					</button>
				{/if}
				<button
					type="button"
					class="icon wide-only"
					class:on={preferences.fileExplorerOpen}
					aria-pressed={preferences.fileExplorerOpen}
					title={explorerLabel}
					aria-label={explorerLabel}
					onclick={() => (preferences.fileExplorerOpen = !preferences.fileExplorerOpen)}
				>
					<iconify-icon icon="mdi:file-tree"></iconify-icon>
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
				<div class="code" class:wrap={preferences.fileWordWrap} bind:this={codeEl} style:--gutter="{String(lines.length).length + 1}ch">
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
	/* Beside an open file the tree sits past it, on the pane's far edge. */
	.picked nav {
		order: 1;
		flex: none;
		width: min(22rem, 46%);
		min-width: 16rem;
		border-left: 1px solid #222;
	}
	.picked.tree-off nav {
		display: none;
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
	/* The way to the file, scrolled to its end: the name is what was asked for. */
	.crumbs {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		overflow-x: auto;
		scrollbar-width: none;
		white-space: nowrap;
	}
	.crumbs::-webkit-scrollbar {
		display: none;
	}
	.crumbs .sep {
		flex: none;
		font-size: 13px;
		color: #57534e;
	}
	.leaf {
		flex: none;
		padding: 0 4px;
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
	.icon:hover,
	.icon.on {
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
	/* Folded at the pane's edge: a block is then as wide as the pane, not as its longest line. */
	.wrap .chunk {
		width: auto;
	}
	.wrap .src {
		min-width: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
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
