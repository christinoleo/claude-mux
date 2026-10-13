<script lang="ts">
	/**
	 * The side panel's one control in the session's status line: it opens the
	 * panel on the pane last shown and closes it again. Which pane shows is
	 * chosen in the panel's own header, where there is room to name them. The
	 * lines the session has changed ride on it, since that is the reason the
	 * panel is most often opened.
	 */
	import type { Session } from '$lib/stores/sessions.svelte';
	import { CLOSE_KEYS } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import DiffBadge from '$lib/components/DiffBadge.svelte';

	let {
		open,
		session,
		onToggle
	}: {
		open: boolean;
		session: Session;
		onToggle: () => void;
	} = $props();

	const label = $derived(open ? 'Close side panel' : 'Open side panel');
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<span {...props} class="tt">
				<Toggle variant="outline" size="xs" pressed={open} aria-label={label} onPressedChange={onToggle}>
					<iconify-icon icon="mdi:dock-right"></iconify-icon>
					<DiffBadge changes={session.changes} />
				</Toggle>
			</span>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content side="top" sideOffset={8}>
		<span class="tip">{label}<kbd>{CLOSE_KEYS}</kbd></span>
	</Tooltip.Content>
</Tooltip.Root>

<style>
	.tt {
		display: inline-flex;
		flex: none;
	}
	.tt :global([data-slot='toggle']) {
		border-color: #2a2a2c;
		color: #a8a29e;
		font-family: var(--font-mono);
	}
	.tt :global([data-slot='toggle'][data-state='on']) {
		background: #232326;
		border-color: #3f3f46;
		color: #f5f5f4;
	}
	.tt iconify-icon {
		font-size: 13px;
	}
	.tip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		padding: 1px 5px;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.14);
	}
</style>
