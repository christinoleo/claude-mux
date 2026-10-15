<script lang="ts" module>
	import type { OpenFolder } from '$shared/folder-marks.js';
	import type { IndicatorState } from '$shared/session-state.js';
	import type { Machine } from '$lib/stores/fleet.svelte';

	/** A project root somewhere in the fleet, as the picker marks it (`folderMarker()`). */
	export interface PickerFolder extends OpenFolder {
		machine: Machine;
		/** The most urgent of its live sessions' states; null with none. */
		state: IndicatorState | null;
		/** The session's pane when exactly one runs there, which "Go to" opens. */
		only: string | null;
		/** Its project's tile (`ProjectTile`). */
		tile: { initials: string; hue: number; icon: string | null };
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { fuzzyMatch, highlightRuns } from '$shared/utils/fuzzy.js';
	import { carryPath, folderMarker, openOn, type FolderMarks } from '$shared/folder-marks.js';
	import type { MachineMark } from '$shared/fleet-rail.js';
	import { apiBase, blockedReason, machineKey, machineName, seenLabel } from '$lib/stores/fleet.svelte';
	import { clock } from '$lib/stores/clock.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Tabs from '$lib/components/ui/tabs';
	import SessionStateIndicator from './SessionStateIndicator.svelte';
	import ProjectTile from './ProjectTile.svelte';

	interface Props {
		open: boolean;
		/** Every machine in the fleet, in its usual order: one tab each. */
		machines: Machine[];
		/** Every project root in the fleet, for the marks. */
		folders: PickerFolder[];
		/** A machine's letter and colour, by id. */
		markOf: (machineId: string) => MachineMark | null;
		/** Called with the machine browsed and the chosen directory when the user picks one. */
		onpick: (machine: Machine, cwd: string) => void;
		/** "Go to" on an open folder. */
		ongoto: (folder: PickerFolder) => void;
	}

	let { open = $bindable(), machines, folders: openFolders, markOf, onpick, ongoto }: Props = $props();

	interface BrowseFolder {
		name: string;
		path: string;
		git?: boolean;
	}

	/** The machine whose disk is browsed, by id; its API is reached through `apiBase()`. */
	let tab = $state('');
	const machine = $derived(machines.find((m) => machineKey(m) === tab) ?? machines[0]);
	const base = $derived(machine ? apiBase(machine) : '');

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

	/** What each folder of the machine browsed is marked with. */
	const mark = $derived(folderMarker(tab, openFolders));
	/** The folders open on the machine browsed, listed above its folders while nothing is typed. */
	const openHere = $derived(openOn(tab, openFolders));

	/** Open on a machine, the one the drawer is filtered to or the origin. */
	export async function openAt(start: string, on: Machine) {
		tab = machineKey(on);
		open = true;
		await browseTo(start);
		// On touch the keyboard would cover the list before the user has decided to
		// filter, so the prompt is focused only for pointers. Tapping it still works.
		if (!window.matchMedia?.('(pointer: coarse)').matches) inputEl?.focus();
	}

	/**
	 * Browse another machine, at the same place relative to home when it has
	 * that folder, else at home.
	 */
	async function switchTo(id: string) {
		const next = machines.find((m) => machineKey(m) === id);
		if (!next || id === tab || blockedReason(next, clock.now)) return;
		const carried = carryPath(path, home);
		tab = id;
		if ((await browseTo(carried, true)) === false && carried !== '~') await browseTo('~', true);
	}

	/** Which browse is the latest, so a slow answer for a tab left behind is dropped. */
	let browsing = 0;

	/** Show a folder of the machine browsed: false when it cannot be read, null when a later browse took over. */
	async function browseTo(to: string, keepQuery = false): Promise<boolean | null> {
		const ask = ++browsing;
		error = '';
		const data = await fetch(`${base}/api/browse?path=${encodeURIComponent(to)}&showHidden=${showHidden}`)
			.then((res) => res.json())
			.catch(() => ({ error: 'Could not reach the machine' }));
		if (ask !== browsing) return null;
		if (data.error) {
			error = data.error;
			return false;
		}
		path = data.current;
		home = data.home;
		parent = data.parent;
		folders = data.folders;
		if (!keepQuery) query = '';
		await tick();
		listEl?.scrollTo({ top: 0 });
		return true;
	}

	/** A path as the crumbs say it: from `~` when it is under home. */
	function shortPath(p: string): string {
		return carryPath(p, home);
	}

	function goTo(folder: PickerFolder) {
		open = false;
		ongoto(folder);
	}

	function moveActive(delta: number) {
		const n = matches.length;
		if (n === 0) return;
		active = (active + delta + n) % n;
		(listEl?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
	}

	function pickCurrent() {
		if (!machine) return;
		open = false;
		onpick(machine, path);
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

{#snippet marks(m: FolderMarks<PickerFolder>)}
	<span class="fb-marks">
		{#if m.here && m.here.live > 0 && m.here.state}
			<span class="fb-live" class:wants={m.here.wants}>
				<SessionStateIndicator state={m.here.state} size="sm" />
				{m.here.live} session{m.here.live === 1 ? '' : 's'}
			</span>
		{:else if m.here}
			<span class="fb-rail" title="{m.here.name} is on the rail">
				<ProjectTile initials={m.here.tile.initials} hue={m.here.tile.hue} icon={m.here.tile.icon} size={14} />
			</span>
		{/if}
		{#each m.elsewhere as other (other.machineId)}
			{@const letter = markOf(other.machineId)}
			<span
				class="fb-mach"
				class:quiet={other.live === 0}
				style="--m:{letter?.color ?? '#a8a29e'}"
				title={other.live > 0
					? `Open on ${machineName(other.machine)}: ${other.live} session${other.live === 1 ? '' : 's'}`
					: `On the rail on ${machineName(other.machine)}`}>{letter?.letter ?? '?'}</span
			>
		{/each}
		{#if m.below > 0}
			<span class="fb-below" title="{m.below} open folder{m.below === 1 ? '' : 's'} below">{m.below} open</span>
		{/if}
	</span>
{/snippet}

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

		{#if machines.length > 1}
			<!-- One tab per machine; one that is offline or too old says why. -->
			<Tabs.Root value={tab} onValueChange={(id) => void switchTo(id)} class="fb-tabs">
				<Tabs.List class="fb-tablist" aria-label="Machine">
					{#each machines as m (machineKey(m))}
						{@const why = blockedReason(m, clock.now)}
						{@const letter = markOf(machineKey(m))}
						<Tabs.Trigger value={machineKey(m)} disabled={!!why} title={why ?? `Browse ${machineName(m)}`} class="fb-tab">
							{#if letter}<span class="fb-mach" style="--m:{letter.color}">{letter.letter}</span>{/if}
							<span class="fb-tabname">{machineName(m)}</span>
							{#if why}<span class="fb-tabwhy">{m.lastSeen ? seenLabel(m.lastSeen, clock.now) : m.online ? 'too old' : 'offline'}</span>{/if}
						</Tabs.Trigger>
					{/each}
				</Tabs.List>
			</Tabs.Root>
		{/if}

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

		<ScrollArea class="max-h-80 min-h-24 border-y border-[#333]">
			{#if !query && openHere.length > 0}
				<section class="fb-open" aria-label="Open on this machine">
					<h3 class="fb-head">Open on this machine</h3>
					{#each openHere as folder (folder.root)}
						<div class="fb-item">
							<button class="fb-main" title={folder.root} onclick={() => browseTo(folder.root)}>
								<span class="fb-name">{shortPath(folder.root)}</span>
								{@render marks({ ...mark(folder.root), below: 0 })}
							</button>
							<button class="fb-goto" title={folder.only ? 'Open its session' : 'Open the project'} onclick={() => goTo(folder)}>Go to</button>
						</div>
					{/each}
					<h3 class="fb-head">In {shortPath(path)}</h3>
				</section>
			{/if}
			<div bind:this={listEl}>
				{#each matches as match, i (match.folder.path)}
					{@const m = mark(match.folder.path)}
					<div class="fb-item" class:active={i === active} role="presentation" onmouseenter={() => (active = i)}>
						<button class="fb-main" onclick={() => browseTo(match.folder.path)}>
							<span class="fb-name"
								>{#if match.runs}{#each match.runs as run}{#if run.hit}<mark>{run.text}</mark
										>{:else}{run.text}{/if}{/each}{:else}{match.folder.name}{/if}</span
							>
							{@render marks(m)}
							{#if match.folder.git}<span class="fb-tag">git</span>{/if}
						</button>
						{#if m.here}
							{@const here = m.here}
							<button class="fb-goto" title={here.only ? 'Open its session' : 'Open the project'} onclick={() => goTo(here)}>Go to</button>
						{/if}
					</div>
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

	/* The machines, as tabs over the path: the one browsed reads like the crumb it heads. */
	:global(.fb-tabs) {
		padding: 0 12px 10px;
	}

	:global(.fb-tablist) {
		display: flex;
		width: 100%;
		max-width: 100%;
		justify-content: flex-start;
		gap: 2px;
		overflow-x: auto;
		background: #1f1f1f;
	}

	:global(.fb-tab) {
		flex: 0 0 auto;
		gap: 6px;
		padding: 2px 9px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: #8a8a8a;
	}

	:global(.fb-tab[data-state='active']) {
		background: #2c2c2c;
		color: #ededed;
	}

	.fb-tabwhy {
		font-size: 10.5px;
		color: #6f6f6f;
	}

	.fb-mach {
		display: inline-grid;
		place-items: center;
		width: 15px;
		height: 15px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--m) 18%, transparent);
		color: var(--m);
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 700;
		line-height: 1;
	}

	.fb-mach.quiet {
		opacity: 0.5;
	}

	.fb-item {
		display: flex;
		align-items: center;
		width: 100%;
		background: transparent;
		border-left: 3px solid transparent;
		color: #c4c4c4;
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

	.fb-main {
		display: flex;
		flex: 1;
		min-width: 0;
		align-items: center;
		gap: 10px;
		padding: 7px 16px 7px 13px;
		background: none;
		border: none;
		font-family: var(--font-mono);
		font-size: 13px;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.fb-main:focus-visible,
	.fb-goto:focus-visible {
		outline: 2px solid var(--fb-accent);
		outline-offset: -2px;
	}

	.fb-marks {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 5px;
	}

	.fb-marks:empty {
		display: none;
	}

	.fb-live {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: #a3a3a3;
	}

	.fb-live.wants {
		color: #fbbf24;
	}

	.fb-rail {
		display: inline-flex;
		opacity: 0.6;
	}

	.fb-below {
		font-size: 10.5px;
		color: #5c5c5c;
	}

	.fb-goto {
		flex-shrink: 0;
		margin-right: 10px;
		padding: 2px 8px;
		border: 1px solid #333;
		border-radius: 4px;
		background: none;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #a3a3a3;
		cursor: pointer;
	}

	.fb-goto:hover {
		border-color: var(--fb-accent);
		color: #ededed;
	}

	.fb-head {
		padding: 9px 16px 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #5c5c5c;
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
		.fb-main {
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
