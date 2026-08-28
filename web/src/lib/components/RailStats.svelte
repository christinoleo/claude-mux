<script lang="ts">
	import { money } from '$lib/format';
	import { edgeColor, SEVERITY } from '$lib/severity';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { usageStore } from '$lib/stores/usage.svelte';

	/** Load only says something once the box is struggling. */
	const LOAD_FLOOR = 85;

	$effect(() => usageStore.subscribe());

	const quota = $derived(usageStore.quota);
	const stats = $derived(sessionStore.systemStats);
	/** Spend has no bar — it is not a share of anything — so it takes the label. */
	const today = $derived(usageStore.today);

	interface Chip {
		key: string;
		text: string;
		percent: number;
		/** Colour, graded by the server where the server grades it. */
		color: string;
	}

	/** Labels share a length so the bars can share a width. */
	function shortLabel(label: string): string {
		const text = label.toLowerCase();
		if (text.includes('session')) return '5h';
		const model = text.match(/(opus|sonnet|haiku|fable|mythos)/)?.[1];
		if (model) return model;
		if (text.includes('week')) return 'wk';
		return text.replace(/\s*limit$/, '').split(/\s+/)[0];
	}

	const chips = $derived.by(() => {
		const out: Chip[] = [];
		for (const limit of quota?.available ? quota.limits : []) {
			out.push({
				key: limit.kind,
				text: `${shortLabel(limit.label)} ${Math.round(limit.percent)}%`,
				percent: limit.percent,
				// The server grades plan limits itself, and the sidebar shows that
				// grade — recomputing here is how the two start disagreeing.
				color: limit.severity === 'normal' ? edgeColor(0) : SEVERITY[limit.severity].color
			});
		}
		if (stats) {
			if (stats.cpu >= LOAD_FLOOR)
				out.push({
					key: 'cpu',
					text: `cpu ${Math.round(stats.cpu)}%`,
					percent: stats.cpu,
					color: edgeColor(stats.cpu)
				});
			if (stats.ram >= LOAD_FLOOR)
				out.push({
					key: 'ram',
					text: `ram ${Math.round(stats.ram)}%`,
					percent: stats.ram,
					color: edgeColor(stats.ram)
				});
		}
		return out;
	});
</script>


{#if chips.length > 0}
	<a class="tkey usage" href="/usage" title={chips.map((c) => c.text).join(' · ')}>
		<span class="bars">
			{#each chips as chip (chip.key)}
				<span class="bar" aria-label={chip.text}>
					<span style="width: {Math.min(100, chip.percent)}%; background: {chip.color}"></span>
				</span>
			{/each}
		</span>
		<span>{today === null ? 'Usage' : money(today, true)}</span>
	</a>
{/if}

<style>
	/* A tile among tiles: the row is keycaps, so a loose glyph reads as dirt.
	   It borrows the row's own .tkey shape and spends its face on the meters
	   instead of an icon — the figures are one tap away, on /usage. */
	.usage {
		text-decoration: none;
		gap: 3px;
	}
	.bars {
		display: flex;
		flex-direction: column;
		gap: 3px;
		width: 26px;
	}
	.bar {
		display: block;
		height: 2px;
		border-radius: 1px;
		background: rgba(245, 245, 244, 0.16);
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
		border-radius: 1px;
	}

	/* A phone has no width to spare, so the tile narrows to its contents —
	   which is why the label is the shortest true thing it can say. */
	@media (max-width: 899px) {
		.usage {
			min-width: 0;
			padding: 0 5px;
		}
		.bars {
			width: 24px;
		}
	}
</style>
