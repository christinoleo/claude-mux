<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { tick } from 'svelte';

	type Kind = 'builtin' | 'command' | 'skill' | 'agent';
	interface Cmd {
		name: string;
		insert: string;
		kind: Kind;
		source: string;
		description: string;
	}

	let {
		open = $bindable(false),
		cwd,
		pinned = [],
		onselect
	}: {
		open: boolean;
		cwd?: string | null;
		pinned?: string[];
		onselect: (insert: string) => void;
	} = $props();

	let query = $state('');
	let commands = $state<Cmd[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
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

	async function load(force = false) {
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

	$effect(() => {
		if (open) {
			query = '';
			activeIndex = 0;
			load();
			tick().then(() => inputEl?.focus());
		}
	});

	/**
	 * Subsequence fuzzy score. Higher is better; null = no match.
	 * Prefers: prefix match, matches at word boundaries, contiguous runs, shorter names.
	 */
	function fuzzyScore(text: string, q: string): number | null {
		if (!q) return 0;
		const t = text.toLowerCase();
		const needle = q.toLowerCase();
		// Fast path: substring
		const idx = t.indexOf(needle);
		if (idx !== -1) return 1000 - idx * 5 - t.length;
		let score = 0;
		let ti = 0;
		let prev = -2;
		for (let qi = 0; qi < needle.length; qi++) {
			const ch = needle[qi];
			const found = t.indexOf(ch, ti);
			if (found === -1) return null;
			score += found === prev + 1 ? 10 : 1;
			if (found === 0 || /[^a-z0-9]/.test(t[found - 1] ?? '')) score += 5;
			prev = found;
			ti = found + 1;
		}
		return score - t.length * 0.1;
	}

	const filtered = $derived.by(() => {
		const q = query.trim();
		const pinSet = new Set(pinned);
		const scored = commands
			.map((c) => {
				const nameScore = fuzzyScore(c.name, q);
				// Description: substring only (subsequence over long prose matches everything)
				const descIdx = q ? c.description.toLowerCase().indexOf(q.toLowerCase()) : -1;
				const descScore = descIdx === -1 ? null : 100 - descIdx * 0.5;
				const best = nameScore != null ? nameScore + 500 : descScore;
				return best == null ? null : { c, score: best };
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
	});

	function choose(c: Cmd) {
		onselect(c.insert);
		open = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
			scrollActiveIntoView();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
			scrollActiveIntoView();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const c = filtered[activeIndex];
			if (c) choose(c);
		}
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

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex h-[85dvh] max-h-[85dvh] w-[calc(100%-1rem)] max-w-xl flex-col gap-0 overflow-hidden border-[#333] bg-[#1a1a1a] p-0 text-stone-100 sm:max-w-xl"
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">Commands</Dialog.Title>
		<Dialog.Description class="sr-only">Search slash commands, skills and agents</Dialog.Description>
		<div class="flex items-center gap-2 border-b border-[#333] px-3 py-2">
			<iconify-icon icon="mdi:magnify" class="shrink-0 text-stone-400" style="font-size: 18px;"></iconify-icon>
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={onKeydown}
				type="text"
				placeholder="Search commands, skills, agents…"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="go"
				class="min-w-0 flex-1 bg-transparent text-base text-stone-100 outline-none placeholder:text-stone-500"
			/>
			<button
				type="button"
				class="shrink-0 rounded p-1 text-stone-400 hover:bg-[#333] hover:text-stone-100"
				title="Refresh"
				onclick={() => load(true)}
			>
				<iconify-icon icon="mdi:refresh" style="font-size: 18px;"></iconify-icon>
			</button>
			<button
				type="button"
				aria-label="Close"
				class="shrink-0 rounded p-1 text-stone-400 hover:bg-[#333] hover:text-stone-100"
				onclick={() => (open = false)}
			>
				<iconify-icon icon="mdi:close" style="font-size: 18px;"></iconify-icon>
			</button>
		</div>

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
	</Dialog.Content>
</Dialog.Root>
