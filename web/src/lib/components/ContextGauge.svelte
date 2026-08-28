<script lang="ts">
	import type { Snippet } from 'svelte';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { compact } from '$lib/format';
	import { edgeColor } from '$lib/severity';
	import { contextPercent, type ContextUsage } from '../../../../src/transcript/context.js';

	interface Props {
		context: ContextUsage | null;
		/** Mounted on the rail — the line routes over it. */
		notch?: Snippet;
	}

	let { context, notch }: Props = $props();

	let open = $state(false);
	let strip = $state<HTMLElement | null>(null);
	let svgEl = $state<SVGSVGElement | null>(null);
	let rightEl = $state<HTMLElement | null>(null);
	let path = $state('');
	let length = $state(0);

	const used = $derived(context ? (contextPercent(context) ?? null) : null);
	const left100 = $derived(used === null ? null : Math.max(0, 100 - used));
	const color = $derived(edgeColor(used ?? 0));

	/**
	 * The rail is one path: it turns the card's top corners and arcs over the
	 * button mounted on it, so the fill's head is never hidden behind anything.
	 */
	function build() {
		if (!strip || !svgEl) return;
		const box = svgEl.getBoundingClientRect();
		const width = box.width;
		if (width <= 0) return;

		const card = strip.parentElement;
		const radius = card
			? Math.min(20, parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0)
			: 0;
		const base = 1;
		const clear = 5;

		const knob = rightEl?.getBoundingClientRect();
		const from = knob ? knob.left - box.left - clear : 0;
		const to = knob ? knob.right - box.left + clear : 0;
		const detour = knob !== undefined && knob.width > 0 && to > radius && from < width - radius;

		let d =
			radius > 0 ? `M0 ${radius + base} A${radius} ${radius} 0 0 1 ${radius} ${base}` : `M0 ${base}`;
		if (detour) {
			const r = (to - from) / 2;
			d +=
				` L${from.toFixed(1)} ${base}` +
				` A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${to.toFixed(1)} ${base}`;
		}
		d +=
			radius > 0
				? ` L${(width - radius).toFixed(1)} ${base} A${radius} ${radius} 0 0 1 ${width.toFixed(1)} ${radius + base}`
				: ` L${width.toFixed(1)} ${base}`;

		path = d;
		svgEl.setAttribute('viewBox', `0 0 ${width.toFixed(1)} ${Math.max(13, radius + base)}`);
		// Measured off a throwaway path so the reading never depends on when the
		// bound path element last rendered.
		const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		probe.setAttribute('d', d);
		svgEl.appendChild(probe);
		length = probe.getTotalLength();
		probe.remove();
	}

	$effect(() => {
		if (!strip) return;
		build();
		const ro = new ResizeObserver(build);
		ro.observe(strip);
		if (rightEl) ro.observe(rightEl);
		return () => ro.disconnect();
	});


</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<div class="strip" bind:this={strip}>
	<button
		type="button"
		class="line"
		aria-expanded={open}
		aria-label={left100 === null
			? 'Context usage. Open details.'
			: `Context: ${left100}% left. Open details.`}
		onclick={() => (open = !open)}
	>
		<svg bind:this={svgEl} aria-hidden="true">
			<path class="track" d={path} />
			<path
				class="fill"
				d={path}
				style="stroke: {color}; stroke-dasharray: {length}; stroke-dashoffset: {length *
					(1 - (used ?? 0) / 100)}"
			/>
		</svg>
	</button>

	<div class="mount-right" bind:this={rightEl}>{@render notch?.()}</div>

	{#if open}
		<div
			class="pop"
			role="dialog"
			aria-label="Context details"
			use:clickOutside={{ enabled: open, onOutside: () => (open = false) }}
		>
			<div class="pop-head">
				<span class="pop-title">Context</span>
				<span class="pop-big">
					{#if left100 === null}{context ? compact(context.tokens) : '—'}{:else}{left100}% left{/if}
				</span>
			</div>
			{#if context}
				<div class="pop-row">
					<span>Used</span>
					<span>
						{compact(context.tokens)}{#if context.window}&nbsp;of {compact(context.window)}{/if}
					</span>
				</div>
				<div class="pop-row"><span>Model</span><span>{context.model || 'unknown'}</span></div>
				{#if !context.window}
					<p class="pop-note">
						No context window on record for this model, so there is no percentage to show —
						only what the last response carried.
					</p>
				{:else if used !== null && used >= 80}
					<p class="pop-note">
						Claude compacts the conversation soon. Anything you want kept, say it now.
					</p>
				{:else}
					<p class="pop-note">Claude compacts the conversation on its own near the limit.</p>
				{/if}
			{:else}
				<p class="pop-note">
					Nothing measured yet. The first response from Claude reports what the window holds.
				</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.strip {
		position: absolute;
		inset: -1px -1px auto -1px;
		height: 13px;
		z-index: 3;
	}

	.line {
		display: block;
		position: absolute;
		inset: 0;
		width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}
	.line:focus-visible {
		outline: 2px solid #fbbf24;
		outline-offset: 3px;
	}

	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 13px;
		overflow: visible;
	}
	path {
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.track {
		stroke: rgba(245, 245, 244, 0.07);
	}
	.fill {
		transition:
			stroke-dashoffset 0.35s ease,
			stroke 0.35s ease;
	}
	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}
	}

	/* centred on the rail's baseline, which is where the arc is drawn; the
	   voice meter hangs off it, above the button */
	.mount-right {
		position: absolute;
		top: -20px;
		right: 15px;
		display: flex;
	}
	.mount-right:empty {
		display: none;
	}

	.pop {
		position: absolute;
		left: 12px;
		right: 12px;
		bottom: 10px;
		max-width: 320px;
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 9px;
		padding: 12px 13px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
		color: #f5f5f4;
	}
	.pop-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.pop-title {
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #78716c;
	}
	.pop-big {
		font-family: var(--font-mono);
		font-size: 20px;
		font-variant-numeric: tabular-nums;
	}
	.pop-row {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		font-size: 12px;
		color: #a8a29e;
	}
	.pop-row span:last-child {
		font-family: var(--font-mono);
		color: #f5f5f4;
		font-variant-numeric: tabular-nums;
	}
	.pop-note {
		font-size: 12px;
		line-height: 1.45;
		color: #78716c;
		border-top: 1px solid #333;
		padding-top: 8px;
		margin: 0;
	}
</style>
