<script lang="ts" module>
	export interface SwitchItem {
		id: string;
		kind: 'session' | 'project' | 'past';
		title: string;
		/** The project and machine a session is in; where a project is held. */
		detail: string;
		/** What typing may match besides the title. */
		fields: (string | number | null | undefined)[];
		tile?: { initials: string; hue: number; icon: string | null };
		machine?: import('$shared/fleet-rail.js').MachineMark | null;
		state?: import('$shared/session-state.js').IndicatorState;
		/** On a machine that does not answer. */
		off?: boolean;
		run: () => void;
	}
</script>

<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import { matchesQuery } from '$shared/fleet-rail.js';
	import ProjectTile from './ProjectTile.svelte';
	import SessionStateIndicator from './SessionStateIndicator.svelte';

	/**
	 * Ctrl+K: jump to any session, project or past session in the fleet by typing. The match
	 * is the drawer filter's (`matchesQuery()`), so `#100` finds the worker on
	 * issue 100 and a machine's name finds what runs there.
	 */
	let { open = $bindable(false), items }: { open: boolean; items: SwitchItem[] } = $props();

	let query = $state('');
	$effect(() => {
		if (open) query = '';
	});

	const LIMIT = 50;
	const hits = $derived(items.filter((it) => matchesQuery(query, [it.title, ...it.fields])).slice(0, LIMIT));
	const sessions = $derived(hits.filter((it) => it.kind === 'session'));
	const projects = $derived(hits.filter((it) => it.kind === 'project'));
	const past = $derived(hits.filter((it) => it.kind === 'past'));

	function pick(item: SwitchItem) {
		open = false;
		item.run();
	}
</script>

<Command.Dialog
	bind:open
	shouldFilter={false}
	title="Jump to"
	description="Find a session, project or past session anywhere in the fleet"
	class="quick-switch"
>
	<Command.Input bind:value={query} placeholder="Jump to a session, project or past session…" />
	<Command.List class="max-h-[60dvh]">
		<Command.Empty>Nothing matches.</Command.Empty>
		{#if sessions.length > 0}
			<Command.Group heading="Sessions">
				{#each sessions as item (item.id)}
					<Command.Item value={item.id} onSelect={() => pick(item)} class={item.off ? 'opacity-50' : ''}>
						<span class="qs-st">{#if item.state}<SessionStateIndicator state={item.state} size="sm" />{/if}</span>
						<span class="qs-title">{item.title}</span>
						<span class="qs-detail">{item.detail}</span>
						{#if item.machine}<span class="qs-mach" style="--m:{item.machine.color}" title={item.machine.name}>{item.machine.letter}</span>{/if}
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
		{#if projects.length > 0}
			<Command.Group heading="Projects">
				{#each projects as item (item.id)}
					<Command.Item value={item.id} onSelect={() => pick(item)}>
						{#if item.tile}<ProjectTile {...item.tile} size={18} />{/if}
						<span class="qs-title">{item.title}</span>
						<span class="qs-detail">{item.detail}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
		{#if past.length > 0}
			<Command.Group heading="Past sessions">
				{#each past as item (item.id)}
					<Command.Item value={item.id} onSelect={() => pick(item)} class={item.off ? 'opacity-50' : ''}>
						<span class="qs-st"><iconify-icon icon="mdi:history"></iconify-icon></span>
						<span class="qs-title">{item.title}</span>
						<span class="qs-detail">{item.detail}</span>
						{#if item.machine}<span class="qs-mach" style="--m:{item.machine.color}" title={item.machine.name}>{item.machine.letter}</span>{/if}
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>

<style>
	.qs-st {
		display: grid;
		place-items: center;
		width: 18px;
		flex: none;
	}
	.qs-title {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.qs-detail {
		flex: none;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #6b6764;
	}
	.qs-mach {
		flex: none;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--m);
	}
</style>
