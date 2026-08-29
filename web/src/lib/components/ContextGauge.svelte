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

	/** Where the rail turns amber, and roughly where Claude starts compacting. */
	const COMPACT_AT = 80;

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
		// The rail turns the card's corner, so it needs as much height as that
		// corner is deep. Fixing it at 13px only ever suited a 12px radius —
		// anything rounder got the arc squashed into the strip.
		const depth = Math.max(13, radius + base);
		svgEl.setAttribute('viewBox', `0 0 ${width.toFixed(1)} ${depth}`);
		svgEl.style.height = `${depth}px`;
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
					{#if left100 === null}{context ? compact(context.tokens) : '—'}{:else}{left100}<em>% left</em>{/if}
				</span>
			</div>

			{#if context && context.window && used !== null}
				<!-- the rail, unrolled: the popover shows the proportion it was
				     opened to explain, rather than restating it as a word -->
				<div class="meter-wrap">
					<div class="meter">
						<div class="meter-fill" style="width: {Math.min(100, used)}%; background: {color}"></div>
						<div class="meter-mark" style="left: {COMPACT_AT}%"></div>
					</div>
				</div>
				<div class="ends">
					<span>{compact(context.tokens)} used</span>
					<span>{compact(context.window)}</span>
				</div>
			{:else if context}
				<div class="ends ends-solo">
					<span>{compact(context.tokens)} in the last response</span>
				</div>
			{/if}

			{#if context}
				<div class="pop-foot">
					<span class="model">{context.model || 'unknown model'}</span>
				</div>
			{/if}

			{#if !context}
				<p class="pop-note">
					Nothing measured yet. The first response from Claude reports what the window holds.
				</p>
			{:else if !context.window}
				<p class="pop-note">
					No context window on record for this model, so there is no percentage to show.
				</p>
			{:else if used !== null && used >= COMPACT_AT}
				<p class="pop-note warn">
					Claude compacts the conversation soon. Anything you want kept, say it now.
				</p>
			{:else}
				<p class="pop-note">Claude compacts on its own near the mark, around {COMPACT_AT}%.</p>
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
		max-width: 340px;
		background: #1a1a1c;
		border: 1px solid #313135;
		border-radius: 12px;
		padding: 14px 15px 13px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		box-shadow: 0 18px 40px rgba(0, 0, 0, 0.6);
		color: #f5f5f4;
	}
	.pop-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	.pop-title {
		font-size: 10px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #78716c;
	}
	.pop-big {
		font-family: var(--font-mono);
		font-size: 26px;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.pop-big em {
		font-style: normal;
		font-size: 13px;
		color: #a8a29e;
		margin-left: 2px;
	}

	/* The rail this popover belongs to is a line that fills, so the popover
	   shows the same line at full size rather than restating it in words. */
	.meter {
		position: relative;
		height: 8px;
		border-radius: 4px;
		background: rgba(245, 245, 244, 0.08);
		overflow: hidden;
	}
	.meter-fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 4px;
		transition: width 0.35s ease;
	}
	@media (prefers-reduced-motion: reduce) {
		.meter-fill {
			transition: none;
		}
	}
	/* Where the rail turns amber — the one number on the bar worth marking. */
	.meter-mark {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: rgba(10, 10, 11, 0.75);
	}

	/* Figures sit under the end of the bar they describe, so the bar reads as
	   the sentence and these are only its endpoints. */
	.meter-wrap {
		position: relative;
	}
	.ends {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: #a8a29e;
	}
	.ends-solo {
		justify-content: flex-start;
	}

	.pop-foot {
		display: flex;
		border-top: 1px solid #2a2a2e;
		padding-top: 10px;
	}
	.model {
		font-family: var(--font-mono);
		font-size: 11px;
		color: #a8a29e;
		background: #232326;
		border-radius: 5px;
		padding: 3px 8px;
	}

	.pop-note {
		font-size: 12px;
		line-height: 1.5;
		color: #78716c;
		margin: 0;
		text-wrap: pretty;
	}
	.pop-note.warn {
		color: #fbbf24;
	}
</style>
