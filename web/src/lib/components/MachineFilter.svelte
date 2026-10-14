<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { clock } from '$lib/stores/clock.svelte';
	import { fleetStore, offlineReason, seenLabel, type Machine } from '$lib/stores/fleet.svelte';

	/**
	 * The drawer's machine filter: which machines the sidebar shows, all of
	 * them or one. It only narrows the list; every machine is reached from
	 * this page through its relay, so nothing here leaves the page.
	 */
	let {
		live,
		wants
	}: {
		/** Live sessions on a machine. */
		live: (machine: Machine) => number;
		/** Whether a session on a machine wants a person. */
		wants: (machine: Machine) => boolean;
	} = $props();

	let open = $state(false);

	const chosen = $derived(fleetStore.visible.length === 1 ? fleetStore.visible[0] : null);
	const label = $derived(
		fleetStore.fleet ? (chosen?.server.hostname ?? 'Fleet') : fleetStore.machines[0]?.server.hostname || 'claude-mux'
	);
	/** A machine left out of the filter has someone waiting on it. */
	const wantsElsewhere = $derived(
		fleetStore.selected !== 'all' && fleetStore.machines.some((m) => m.server.id !== fleetStore.selected && wants(m))
	);

	function pick(id: string) {
		fleetStore.select(id);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="machine-filter-trigger" aria-label="Filter by machine" disabled={!fleetStore.fleet}>
		<span class="dot" class:off={chosen ? !chosen.online : false} class:all={!chosen && fleetStore.fleet}></span>
		<span class="hostname">{label}</span>
		{#if wantsElsewhere}<span class="elsewhere" title="A machine not shown wants you"></span>{/if}
		{#if fleetStore.fleet}<iconify-icon icon="mdi:chevron-down" class="chev"></iconify-icon>{/if}
	</Popover.Trigger>
	<Popover.Content class="machine-filter" align="start" sideOffset={6}>
		<button type="button" class="row" class:on={fleetStore.selected === 'all'} onclick={() => pick('all')}>
			<iconify-icon icon="mdi:monitor-multiple" class="lead"></iconify-icon>
			<span class="name">All machines</span>
			{#if fleetStore.selected === 'all'}<iconify-icon icon="mdi:check" class="check"></iconify-icon>{/if}
		</button>
		<div class="rule"></div>
		{#each fleetStore.machines as machine (machine.server.id || machine.server.hostname)}
			{@const reason = offlineReason(machine, clock.now)}
			{@const on = fleetStore.selected === machine.server.id}
			{@const n = live(machine)}
			<button
				type="button"
				class="row"
				class:on
				disabled={!machine.server.id}
				title={reason ?? undefined}
				onclick={() => pick(machine.server.id)}
			>
				<span class="dot lead" class:off={!machine.online}></span>
				<span class="name">
					{machine.server.hostname || 'this machine'}
					{#if reason}<span class="sub">{machine.lastSeen ? `offline, ${seenLabel(machine.lastSeen, clock.now)}` : 'offline'}</span>{/if}
				</span>
				{#if wants(machine)}<span class="pill">wants you</span>{/if}
				{#if n > 0}<span class="n">{n}</span>{/if}
				{#if on}<iconify-icon icon="mdi:check" class="check"></iconify-icon>{/if}
			</button>
		{/each}
	</Popover.Content>
</Popover.Root>

<style>
	:global(.machine-filter-trigger) {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		padding: 4px 6px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: #e7e5e4;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	:global(.machine-filter-trigger:hover) {
		background: var(--surface-3);
	}
	:global(.machine-filter-trigger:disabled) {
		cursor: default;
	}
	:global(.machine-filter-trigger .hostname) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:global(.machine-filter-trigger .chev) {
		font-size: 14px;
		color: #6b6764;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #34d399;
		flex: none;
	}
	.dot.off {
		background: #3a3836;
	}
	/* "All": a ring rather than a dot, since it stands for several machines. */
	.dot.all {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px #34d399;
	}
	.elsewhere {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #f59e0b;
		flex: none;
	}
	:global(.machine-filter) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 240px;
		padding: 6px;
		background: #151516;
		border: 1px solid #2a2a2c;
		border-radius: 12px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 32px;
		padding: 4px 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: #d6d3d1;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.row:hover:not(:disabled) {
		background: #212124;
		color: #f5f5f4;
	}
	.row.on {
		color: #f5f5f4;
	}
	.row:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.lead {
		flex: none;
	}
	iconify-icon.lead {
		font-size: 15px;
		color: #a8a29e;
	}
	.dot.lead {
		margin: 0 4px;
	}
	.name {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 11px;
		color: #6b6764;
	}
	.pill {
		flex: none;
		padding: 1px 6px;
		border-radius: 6px;
		background: #3a2d0d;
		color: #f59e0b;
		font-size: 10.5px;
	}
	.n {
		flex: none;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #6b6764;
	}
	.check {
		flex: none;
		font-size: 14px;
		color: #34d399;
	}
	.rule {
		height: 1px;
		margin: 2px 4px;
		background: #2a2a2c;
	}
</style>
