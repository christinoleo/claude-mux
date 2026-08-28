<script lang="ts">
	import { tick } from 'svelte';
	import { fuzzyMatch, highlightRuns } from '$lib/fuzzy';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ScrollArea } from '$lib/components/ui/scroll-area';

	interface Props {
		open: boolean;
		/** Called with the chosen directory when the user picks one. */
		onpick: (cwd: string) => void;
	}

	let { open = $bindable(), onpick }: Props = $props();

	interface BrowseFolder {
		name: string;
		path: string;
		git?: boolean;
	}

	let path = $state('');
	let home = $state('');
	let parent = $state<string | null>(null);
	let folders = $state<BrowseFolder[]>([]);
	let showHidden = $state(false);
	let error = $state('');
	let query = $state('');
	let active = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	/** Folders of the current dir, fuzzy-filtered and ranked, with matched chars marked. */
	const matches = $derived.by(() => {
		const q = query.trim();
		return folders
			.flatMap((folder) => {
				const m = fuzzyMatch(folder.name, q);
				if (!m) return [];
				// Runs only matter while filtering; an unfiltered list renders the name.
				return [{ folder, score: m.score, runs: q ? highlightRuns(folder.name, m.positions) : null }];
			})
			.sort((a, b) => b.score - a.score);
	});

	/** The current path as clickable segments — the path is the navigation. */
	const crumbs = $derived.by(() => {
		if (!path) return [];
		const usesHome = home !== '' && `${path}/`.startsWith(`${home}/`);
		const parts = (usesHome ? path.slice(home.length) : path).split('/').filter(Boolean);
		const list = usesHome ? [{ label: '~', path: home }] : [{ label: '/', path: '/' }];
		let acc = usesHome ? home : '';
		for (const part of parts) {
			acc = `${acc}/${part}`;
			list.push({ label: part, path: acc });
		}
		return list;
	});

	$effect(() => {
		// A new result set always starts at the top.
		matches;
		active = 0;
	});

	export async function openAt(start = '~') {
		open = true;
		await browseTo(start);
		// On touch the keyboard would cover the list before the user has decided to
		// filter, so the prompt is focused only for pointers. Tapping it still works.
		if (!window.matchMedia?.('(pointer: coarse)').matches) inputEl?.focus();
	}

	async function browseTo(to: string, keepQuery = false) {
		error = '';
		const res = await fetch(
			`/api/browse?path=${encodeURIComponent(to)}&showHidden=${showHidden}`
		);
		const data = await res.json();
		if (data.error) {
			error = data.error;
			return;
		}
		path = data.current;
		home = data.home;
		parent = data.parent;
		folders = data.folders;
		if (!keepQuery) query = '';
		await tick();
		listEl?.scrollTo({ top: 0 });
	}

	function moveActive(delta: number) {
		const n = matches.length;
		if (n === 0) return;
		active = (active + delta + n) % n;
		(listEl?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
	}

	function pickCurrent() {
		open = false;
		onpick(path);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
			e.preventDefault();
			moveActive(1);
		} else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
			e.preventDefault();
			moveActive(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			// Cmd/Ctrl+Enter picks the current directory as-is
			if (e.metaKey || e.ctrlKey) {
				pickCurrent();
				return;
			}
			const match = matches[active];
			if (match) void browseTo(match.folder.path);
			else pickCurrent();
		} else if (e.key === 'Backspace' && query === '' && parent) {
			e.preventDefault();
			void browseTo(parent);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="w-[calc(100%-1.5rem)] max-w-lg gap-0 overflow-hidden border-[#333] bg-[#161616] p-0 sm:max-w-lg"
		style="--fb-accent: #e8b35c;"
		showCloseButton={false}
		onOpenAutoFocus={(e) => {
			// The dialog would focus the prompt on touch too; openAt decides.
			e.preventDefault();
		}}
	>
		<Dialog.Title
			class="px-4 pt-3 pb-2.5 font-mono text-[11px] font-medium tracking-[0.14em] text-[#6f6f6f] uppercase"
		>
			open project
		</Dialog.Title>
		<Dialog.Description class="sr-only">
			Browse to a folder and start a session in it. Type to filter this folder.
		</Dialog.Description>

		<nav class="fb-crumbs" aria-label="Current path">
			{#each crumbs as crumb, i (crumb.path)}
				{@const here = i === crumbs.length - 1}
				{#if i > 0}<span class="fb-sep" aria-hidden="true">/</span>{/if}
				<button
					class="fb-crumb"
					class:here
					aria-current={here ? 'location' : undefined}
					onclick={() => browseTo(crumb.path)}
				>
					{crumb.label}
				</button>
			{/each}
		</nav>

		<div class="fb-prompt">
			<span class="fb-caret" aria-hidden="true">❯</span>
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={onKeydown}
				type="text"
				placeholder="type to filter"
				aria-label="Filter folders in this directory"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="go"
			/>
			<span class="fb-count">{query ? `${matches.length}/${folders.length}` : folders.length}</span>
		</div>

		{#if error}
			<p class="fb-error">{error}</p>
		{/if}

		<ScrollArea class="max-h-72 min-h-24 border-y border-[#333]">
			<div bind:this={listEl}>
				{#each matches as match, i (match.folder.path)}
					<button
						class="fb-item"
						class:active={i === active}
						onmouseenter={() => (active = i)}
						onclick={() => browseTo(match.folder.path)}
					>
						<span class="fb-name"
							>{#if match.runs}{#each match.runs as run}{#if run.hit}<mark>{run.text}</mark
									>{:else}{run.text}{/if}{/each}{:else}{match.folder.name}{/if}</span
						>
						{#if match.folder.git}<span class="fb-tag">git</span>{/if}
					</button>
				{:else}
					<p class="fb-empty">
						{#if query}
							No folder here matches <span class="fb-empty-q">{query}</span>. Backspace to clear.
						{:else}
							No folders here. Open this one, or go up a level.
						{/if}
					</p>
				{/each}
			</div>
		</ScrollArea>

		<div class="fb-keys">
			<span class="fb-hints">↑↓ move · ⏎ enter folder · ⌫ go up · ⌘⏎ open here</span>
			<div class="fb-hidden">
				<Checkbox
					id="fb-show-hidden"
					checked={showHidden}
					onCheckedChange={(v) => {
						showHidden = !!v;
						browseTo(path, true);
					}}
				/>
				<label for="fb-show-hidden">hidden</label>
			</div>
		</div>

		<div class="fb-footer">
			<Button variant="ghost" size="sm" onclick={() => (open = false)}>Cancel</Button>
			<Button size="sm" onclick={pickCurrent}>Open here</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	/* A shell prompt, not a file dialog: the path is the navigation, the input is
	   the command line, matched characters are marked like fzf. */
	.fb-crumbs,
	.fb-prompt,
	.fb-error,
	.fb-item,
	.fb-empty,
	.fb-hints,
	.fb-hidden label {
		font-family: var(--font-mono);
	}

	.fb-crumbs {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 1px;
		padding: 0 16px 10px;
		font-size: 12.5px;
	}

	.fb-crumb {
		background: none;
		border: none;
		padding: 2px 3px;
		border-radius: 3px;
		font: inherit;
		color: #8a8a8a;
		cursor: pointer;
	}

	.fb-crumb:hover {
		color: #e6e6e6;
		background: #242424;
	}

	.fb-crumb.here {
		color: #ededed;
		cursor: default;
	}

	.fb-sep {
		color: #4a4a4a;
	}

	.fb-prompt {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 10px;
		padding: 0 16px 12px;
	}

	.fb-caret {
		font-family: var(--font-mono);
		font-size: 14px;
		line-height: 1;
		color: var(--fb-accent);
	}

	.fb-prompt input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		font-family: var(--font-mono);
		/* 16px keeps mobile Safari from zooming the dialog on focus */
		font-size: 16px;
		color: #ededed;
		caret-color: var(--fb-accent);
	}

	.fb-prompt input::placeholder {
		color: #555;
	}

	.fb-count {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #5c5c5c;
		font-variant-numeric: tabular-nums;
	}

	.fb-error {
		padding: 0 16px 12px;
		font-size: 12px;
		color: #e07a6b;
	}

	.fb-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 7px 16px 7px 13px;
		background: transparent;
		border: none;
		border-left: 3px solid transparent;
		font-family: var(--font-mono);
		font-size: 13px;
		color: #c4c4c4;
		text-align: left;
		cursor: pointer;
		transition:
			background 0.09s ease,
			color 0.09s ease;
	}

	.fb-item:hover,
	.fb-item.active {
		background: #212121;
		color: #f2f2f2;
		border-left-color: var(--fb-accent);
	}

	.fb-item:focus-visible {
		outline: 2px solid var(--fb-accent);
		outline-offset: -2px;
	}

	.fb-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.fb-name mark {
		background: none;
		color: var(--fb-accent);
		font-weight: 600;
	}

	.fb-tag {
		flex-shrink: 0;
		font-size: 10px;
		letter-spacing: 0.08em;
		color: #5a6978;
	}

	.fb-empty {
		padding: 20px 16px;
		font-size: 12.5px;
		line-height: 1.6;
		color: #6f6f6f;
	}

	.fb-empty-q {
		color: var(--fb-accent);
	}

	.fb-keys {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 14px 8px 16px;
	}

	.fb-hints {
		flex: 1;
		min-width: 0;
		font-size: 10.5px;
		color: #4a4a4a;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.fb-hidden {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 6px;
	}

	.fb-hidden label {
		font-size: 10.5px;
		letter-spacing: 0.04em;
		color: #5c5c5c;
		cursor: pointer;
	}

	.fb-footer {
		display: flex;
		min-width: 0;
		justify-content: flex-end;
		gap: 6px;
		padding: 0 12px 12px;
	}

	@media (pointer: coarse) {
		.fb-item {
			padding-block: 11px;
		}
	}

	/* Touch-sized dialog: the key hints are for keyboards, so they go first. */
	@media (max-width: 480px) {
		.fb-hints {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.fb-item {
			transition: none;
		}
	}
</style>
