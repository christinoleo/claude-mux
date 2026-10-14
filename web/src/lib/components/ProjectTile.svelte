<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar';

	/**
	 * A project's tile: its icon, or its initials on its own hue
	 * (`projectInitials()`, `projectHue()`), the same on every machine and link.
	 */
	let {
		initials,
		hue,
		icon,
		size = 20
	}: {
		initials: string;
		hue: number;
		/** The icon's URL; null draws the initials. */
		icon: string | null;
		size?: number;
	} = $props();
</script>

<Avatar.Root class="ptile" style="--h:{hue}; --s:{size}px">
	{#if icon}<Avatar.Image src={icon} alt="" class="ptile-img" draggable="false" />{/if}
	<Avatar.Fallback class="ptile-init">{initials}</Avatar.Fallback>
</Avatar.Root>

<style>
	:global(.ptile) {
		width: var(--s);
		height: var(--s);
		border-radius: calc(var(--s) * 0.3);
		flex: none;
	}
	:global(.ptile::after) {
		border-radius: inherit;
		border-color: hsl(var(--h) 50% 34%);
	}
	:global(.ptile-img) {
		border-radius: inherit;
		object-fit: contain;
		background: #1b1b1d;
		padding: calc(var(--s) * 0.14);
	}
	:global(.ptile-init) {
		border-radius: inherit;
		background: hsl(var(--h) 45% 22%);
		color: hsl(var(--h) 85% 82%);
		font: 650 calc(var(--s) * 0.42) / 1 var(--font-sans, system-ui);
		letter-spacing: 0.02em;
	}
</style>
