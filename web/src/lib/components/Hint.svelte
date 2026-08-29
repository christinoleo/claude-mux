<script lang="ts">
	/**
	 * An icon button that says what it does, and which key does it, on hover.
	 *
	 * The composer's controls are all glyphs with no caption, so the shortcut
	 * has to live somewhere — a tooltip is the only place left that costs no
	 * room. Built on the shadcn tooltip, delegating the trigger to this
	 * button so nothing nests inside anything else.
	 */
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		icon: string;
		/** What the control does, in the words a person would use. */
		label: string;
		/** The keys that do the same thing, e.g. `Ctrl K`. Omit when there are none. */
		keys?: string | null;
		class?: string;
		disabled?: boolean;
		onclick: () => void;
	}

	let { icon, label, keys = null, class: klass = '', disabled = false, onclick }: Props = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={klass}
				{disabled}
				aria-label={keys ? `${label} (${keys})` : label}
				{onclick}
			>
				<iconify-icon {icon}></iconify-icon>
			</button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content side="top" sideOffset={8}>
		<span class="tip">
			{label}
			{#if keys}<kbd>{keys}</kbd>{/if}
		</span>
	</Tooltip.Content>
</Tooltip.Root>

<style>
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
