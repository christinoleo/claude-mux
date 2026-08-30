<script lang="ts">
	import { tick } from 'svelte';
	import { scoreCommand } from '$shared/claude/commands.js';

	type Kind = 'builtin' | 'command' | 'skill' | 'agent';
	interface Cmd {
		name: string;
		insert: string;
		kind: Kind;
		source: string;
		description: string;
	}

	let {
		cwd,
		pinned = [],
		query = '',
		onselect
	}: {
		cwd?: string | null;
		pinned?: string[];
		query?: string;
		onselect: (insert: string) => void;
	} = $props();

	let commands = $state<Cmd[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let activeIndex = $state(0);
	let listEl = $state<HTMLDivElement | null>(null);
	let loadedFor: string | null | undefined = undefined;

	const KIND_LABEL: Record<Kind, string> = {
		builtin: 'built-in',
		command: 'command',
		skill: 'skill',
		agent: 'agent'
	};
	const KIND_COLOR: Record<Kind, string> = {
		builtin: 'text-stone-400',
		command: 'text-sky-400',
		skill: 'text-emerald-400',
		agent: 'text-fuchsia-400'
	};

	export async function reload(force = false) {
		if (!force && loadedFor === cwd && commands.length) return;
		loading = true;
		error = null;
		try {
			const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
			const res = await fetch(`/api/commands${qs}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			commands = data.commands ?? [];
			loadedFor = cwd;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// Load on mount and whenever the cwd changes
	$effect(() => {
		cwd;
		void reload();
	});

	const filtered = $derived.by(() => {
		const q = query.trim();
		const pinSet = new Set(pinned);
		const scored = commands
			.map((c) => {
				const score = scoreCommand(c, q);
				return score == null ? null : { c, score };
			})
			.filter((x): x is { c: Cmd; score: number } => x != null);
		if (q) {
			scored.sort((a, b) => b.score - a.score);
		} else {
			// No query: pinned first, then by kind, then alpha
			const kindOrder: Record<Kind, number> = { command: 0, skill: 1, agent: 2, builtin: 3 };
			scored.sort((a, b) => {
				const pa = pinSet.has(a.c.insert) ? 0 : 1;
				const pb = pinSet.has(b.c.insert) ? 0 : 1;
				if (pa !== pb) return pa - pb;
				if (pa === 0) return pinned.indexOf(a.c.insert) - pinned.indexOf(b.c.insert);
				const ko = kindOrder[a.c.kind] - kindOrder[b.c.kind];
				if (ko !== 0) return ko;
				return a.c.name.localeCompare(b.c.name);
			});
		}
		return scored.map((x) => x.c);
	});

	$effect(() => {
		// reset highlight whenever results change
		filtered;
		activeIndex = 0;
		void tick().then(() => listEl?.scrollTo({ top: 0 }));
	});

	function choose(c: Cmd) {
		onselect(c.insert);
	}

	/** Pick the highlighted entry. Returns false when there is nothing to pick. */
	export function chooseActive(): boolean {
		const c = filtered[activeIndex];
		if (!c) return false;
		choose(c);
		return true;
	}

	/**
	 * Keyboard navigation for a host input. Returns true when the event was
	 * consumed (arrow navigation or selection), false to let the host handle it.
	 */
	export function handleKeydown(e: KeyboardEvent): boolean {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
			scrollActiveIntoView();
			return true;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
			scrollActiveIntoView();
			return true;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			if (!filtered.length) return false;
			e.preventDefault();
			return chooseActive();
		}
		return false;
	}

	function scrollActiveIntoView() {
		tick().then(() => {
			listEl?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
		});
	}

	function sourceLabel(c: Cmd): string {
		if (c.source === 'builtin') return '';
		return c.source;
	}
</script>

<div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
	{#if loading && !commands.length}
		<div class="p-4 text-sm text-stone-400">Loading…</div>
	{:else if error}
		<div class="p-4 text-sm text-red-400">Failed to load: {error}</div>
	{:else if !filtered.length}
		<div class="p-4 text-sm text-stone-400">No matches</div>
	{:else}
		{#each filtered as c, i (c.name + c.source)}
			<button
				type="button"
				data-idx={i}
				class="flex w-full flex-col items-start gap-0.5 border-b border-[#262626] px-3 py-2 text-left hover:bg-[#262626] {i === activeIndex ? 'bg-[#2a2a2a]' : ''}"
				onclick={() => choose(c)}
				onpointerenter={() => (activeIndex = i)}
			>
				<div class="flex w-full items-center gap-2">
					<span class="truncate font-mono text-sm">{c.name}</span>
					<span class="ml-auto shrink-0 text-[10px] uppercase tracking-wide {KIND_COLOR[c.kind]}">{KIND_LABEL[c.kind]}</span>
					{#if sourceLabel(c)}
						<span class="shrink-0 text-[10px] text-stone-500">{sourceLabel(c)}</span>
					{/if}
				</div>
				{#if c.description}
					<div class="line-clamp-2 w-full text-xs text-stone-400">{c.description}</div>
				{/if}
			</button>
		{/each}
	{/if}
</div>
<div class="border-t border-[#333] px-3 py-1 text-[10px] text-stone-500">
	{filtered.length}/{commands.length} · ↑↓ navigate · Enter insert
</div>
