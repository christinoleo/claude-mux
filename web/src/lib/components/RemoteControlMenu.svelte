<script lang="ts">
	/**
	 * Remote Control for the session on the page: one button in the status
	 * line that opens what fits the state. Off, it offers to turn it on; on,
	 * to open the session in the Claude app, copy its link, or turn it off.
	 *
	 * Turning either way goes through the pane and only shows once the poll
	 * sees it, so between the ask and that the button says it is pending.
	 */
	import * as Popover from '$lib/components/ui/popover';
	import type { ChordAction } from '$lib/stores/sidebarActions.svelte';

	interface Props {
		/** The session's Remote Control link, or null while it is off. */
		url: string | null;
		/** The way it was asked to turn, until the poll sees it turn. */
		pending: 'on' | 'off' | null;
		/** What fits the state, built by the page so the chord menu offers the same. */
		actions: ChordAction[];
	}

	let { url, pending, actions }: Props = $props();

	let open = $state(false);

	const label = $derived(
		pending ? `Turning Remote Control ${pending}…` : `Remote Control is ${url ? 'on' : 'off'}`
	);

	function pick(action: ChordAction) {
		open = false;
		action.run();
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="mini rc-trigger" aria-label={label} title={label} data-on={url ? '' : undefined} data-pending={pending ?? undefined}>
		<iconify-icon icon={url ? 'mdi:cellphone-link' : 'mdi:cellphone-link-off'}></iconify-icon>
	</Popover.Trigger>
	<Popover.Content side="top" align="end" sideOffset={8} role="menu" class="rc-menu w-60 max-w-[85vw] border-[#333] bg-[#1a1a1a] p-1">
		<div class="rc-head" role="presentation">
			<span class="rc-dot" data-on={url ? '' : undefined} data-pending={pending ?? undefined}></span>
			{label}
		</div>
		{#each actions as action (action.label)}
			<button type="button" role="menuitem" class="rc-item" class:danger={action.danger} disabled={action.disabled} onclick={() => pick(action)}>
				<iconify-icon icon={action.icon}></iconify-icon>
				{action.label}
			</button>
		{/each}
	</Popover.Content>
</Popover.Root>

<style>
	/* On reads in the sidebar's Remote Control indigo, so the two agree. */
	:global(.rc-trigger[data-on]) {
		color: #818cf8 !important;
	}
	:global(.rc-trigger[data-pending] iconify-icon),
	.rc-dot[data-pending] {
		animation: rc-wait 1.2s steps(2, jump-none) infinite;
	}
	@keyframes rc-wait {
		from {
			opacity: 1;
		}
		to {
			opacity: 0.35;
		}
	}
	.rc-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px 8px;
		font-size: 11px;
		letter-spacing: 0.02em;
		color: #a8a29e;
	}
	.rc-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #57534e;
		flex: none;
	}
	.rc-dot[data-on] {
		background: #818cf8;
	}
	.rc-item {
		display: flex;
		width: 100%;
		min-height: 34px;
		align-items: center;
		gap: 10px;
		border-radius: 6px;
		padding: 0 8px;
		font-size: 13px;
		color: #e7e5e4;
		text-align: left;
		cursor: pointer;
	}
	.rc-item iconify-icon {
		font-size: 16px;
		color: #a8a29e;
	}
	.rc-item:hover:not(:disabled) {
		background: #262626;
	}
	.rc-item:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.rc-item.danger,
	.rc-item.danger iconify-icon {
		color: #fca5a5;
	}
	@media (pointer: coarse) {
		.rc-item {
			min-height: 44px;
		}
	}
</style>
