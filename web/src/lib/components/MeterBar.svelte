<script lang="ts">
	import { SEVERITY, type Severity } from '$lib/severity';

	interface Props {
		label: string;
		/** 0–100. Clamped for the fill; the displayed value is not. */
		percent: number;
		severity?: Severity;
		/** Overrides the rendered percentage, e.g. "1.2G". */
		valueText?: string;
		/** Small text under the bar, left and right. */
		footLeft?: string;
		footRight?: string;
		showIcon?: boolean;
		/** Sidebar sizing: smaller type, thinner track. */
		compact?: boolean;
	}

	let {
		label,
		percent,
		severity = 'normal',
		valueText,
		footLeft,
		footRight,
		showIcon = false,
		compact = false
	}: Props = $props();

	const style = $derived(SEVERITY[severity]);
	const width = $derived(Math.min(100, Math.max(0, percent)));
</script>

<div class="meter" class:compact>
	<span class="head">
		{#if showIcon}
			<iconify-icon icon={style.icon} style="color: {style.color}"></iconify-icon>
		{/if}
		<span class="label">{label}</span>
		<span class="value" style="color: {style.color}">
			{valueText ?? `${Math.round(percent)}%`}
		</span>
	</span>
	<span class="track">
		<span class="fill" style="width: {width}%; background: {style.color}"></span>
	</span>
	{#if footLeft || footRight}
		<span class="foot">
			{#if footLeft}<span class="word" style="color: {style.color}">{footLeft}</span>{/if}
			{#if footRight}<span class="note">{footRight}</span>{/if}
		</span>
	{/if}
</div>

<style>
	.meter {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.compact .label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #a8a29e;
	}

	.value {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		flex: none;
	}

	.compact .value {
		font-size: 11px;
	}

	.track {
		height: 6px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.08);
		overflow: hidden;
	}

	.compact .track {
		height: 4px;
	}

	.fill {
		display: block;
		height: 100%;
		border-radius: 3px;
		transition: width 600ms ease;
	}

	.foot {
		display: flex;
		gap: 8px;
		font-size: 11px;
		color: #a8a29e;
	}

	.word {
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 10px;
		font-weight: 600;
	}

	.note {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 720px) {
		/* On a phone a full-size meter is the thing being read, so it grows. */
		.meter:not(.compact) .value {
			font-size: 18px;
		}

		.meter:not(.compact) .track {
			height: 10px;
		}
	}
</style>
