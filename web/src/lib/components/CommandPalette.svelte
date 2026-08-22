<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { tick } from 'svelte';
	import CommandList from './CommandList.svelte';

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
	let inputEl = $state<HTMLInputElement | null>(null);
	let list = $state<CommandList | null>(null);

	$effect(() => {
		if (open) {
			query = '';
			tick().then(() => inputEl?.focus());
		}
	});

	function choose(insert: string) {
		onselect(insert);
		open = false;
	}

	function onKeydown(e: KeyboardEvent) {
		list?.handleKeydown(e);
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
				onclick={() => list?.reload(true)}
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

		<CommandList bind:this={list} {cwd} {pinned} {query} onselect={choose} />
	</Dialog.Content>
</Dialog.Root>
