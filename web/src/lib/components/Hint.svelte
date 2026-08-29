<script lang="ts">
	/**
	 * An icon button that says what it does, and which key does it, on hover.
	 *
	 * The composer's controls are all glyphs with no caption, so the shortcut
	 * has to live somewhere — a tooltip is the only place left that costs no
	 * room. Built on the shadcn tooltip, delegating the trigger to this
	 * button so nothing nests inside anything else.
	 *
	 * A finger has no hover to leave, so on a touch screen the tooltip's own
	 * trigger opens a label that then sits there until you tap somewhere else.
	 * There, the hold is the question and the tap is the answer: press and the
	 * label appears for as long as you hold it, and the action does not run;
	 * tap and the action runs with nothing drawn. Held, then, means "what is
	 * this?" — the same gesture the mic already answers with its settings.
	 */
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { longPress } from '$lib/actions/longPress';

	interface Props {
		icon: string;
		/** What the control does, in the words a person would use. */
		label: string;
		/** The keys that do the same thing, e.g. `Ctrl K`. Omit when there are none. */
		keys?: string | null;
		class?: string;
		onclick: () => void;
	}

	let { icon, label, keys = null, class: klass = '', onclick }: Props = $props();

	/**
	 * A screen driven by a finger: no hover to leave, and a pointer too coarse
	 * to have one. Both halves are needed — a headless browser reports no
	 * hover either, and there the tooltip should behave as it always has.
	 */
	let touch = $state(false);
	$effect(() => {
		const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
		const sync = () => (touch = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	let open = $state(false);
	/** How long a hold has to last before it counts as a question. */
	const HOLD_MS = 350;
</script>

<Tooltip.Root
	bind:open={() => open, (v) => { if (!touch) open = v; }}
>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={klass}
				aria-label={keys ? `${label} (${keys})` : label}
				{onclick}
				use:longPress={{
					ms: HOLD_MS,
					enabled: () => touch,
					onTrigger: () => (open = true),
					onRelease: () => (open = false)
				}}
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
