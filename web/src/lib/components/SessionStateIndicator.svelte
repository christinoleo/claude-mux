<script lang="ts">
	import { sessionStateVisual, type IndicatorState } from '$shared/session-state.js';

	let {
		state,
		size = 'md',
		title = null
	}: { state: IndicatorState; size?: 'sm' | 'md' | 'lg'; title?: string | null } = $props();

	const visual = $derived(sessionStateVisual(state));
	// A dot reads heavier than a glyph, so it is drawn smaller at the same density.
	const px = $derived(
		{ sm: { dot: 7, icon: 13 }, md: { dot: 8, icon: 15 }, lg: { dot: 12, icon: 18 } }[size]
	);
	const label = $derived(title || visual.label);
</script>

{#if visual.icon}
	<iconify-icon
		class="state-icon"
		icon={visual.icon}
		style="color: {visual.color}; font-size: {px.icon}px;"
		role="img"
		aria-label={label}
		{title}
	></iconify-icon>
{:else}
	<span
		class="state-dot"
		class:pulse-dot={visual.pulse}
		style="background: {visual.color}; width: {px.dot}px; height: {px.dot}px;"
		role="img"
		aria-label={label}
		{title}
	></span>
{/if}

<style>
	.state-icon {
		flex-shrink: 0;
		line-height: 1;
	}

	/* .pulse-dot (app.css) is animation-only; the shape lives here. */
	.state-dot {
		display: inline-block;
		border-radius: 50%;
		flex-shrink: 0;
	}
</style>
