<script lang="ts">
	/**
	 * One toggle per pane kind, in the session's status line: pressed while its
	 * pane shows, closing the panel when pressed again, switching the panel to
	 * its pane otherwise. A pane that cannot apply is disabled, and says why.
	 */
	import type { Session } from '$lib/stores/sessions.svelte';
	import { PANES, paneKeys } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let {
		kind,
		session,
		onToggle
	}: {
		/** The pane showing, if any. */
		kind: string | null;
		session: Session | null;
		onToggle: (kind: string) => void;
	} = $props();
</script>

<span class="toggles">
	{#each PANES as pane (pane.kind)}
		{@const reason = pane.unavailable?.(session) ?? null}
		{@const count = pane.count?.(session) ?? null}
		{@const shown = !!count && (count.additions > 0 || count.deletions > 0)}
		<Tooltip.Root>
			<!-- The trigger wraps the toggle, so a disabled one still explains itself. -->
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<span {...props} class="tt">
						<Toggle
							variant="outline"
							size="xs"
							pressed={kind === pane.kind}
							disabled={reason !== null}
							aria-label={pane.label}
							onPressedChange={() => onToggle(pane.kind)}
						>
							<iconify-icon icon={pane.icon}></iconify-icon>
							{#if shown}
								<span class="add">+{count!.additions}</span><span class="del">−{count!.deletions}</span>
							{/if}
						</Toggle>
					</span>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="top" sideOffset={8}>
				<span class="tip">
					{reason ?? pane.label}
					{#if !reason}<kbd>{paneKeys(pane)}</kbd>{/if}
				</span>
			</Tooltip.Content>
		</Tooltip.Root>
	{/each}
</span>

<style>
	.toggles {
		display: inline-flex;
		gap: 4px;
		flex: none;
	}
	.tt {
		display: inline-flex;
	}
	.toggles :global([data-slot='toggle']) {
		border-color: #2a2a2c;
		color: #a8a29e;
		font-family: var(--font-mono);
	}
	.toggles :global([data-slot='toggle'][data-state='on']) {
		background: #232326;
		border-color: #3f3f46;
		color: #f5f5f4;
	}
	.toggles iconify-icon {
		font-size: 13px;
	}
	.add {
		color: #4ade80;
	}
	.del {
		color: #f87171;
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
