<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import QuotaBars from './QuotaBars.svelte';
	import { compact, hostTimeZone, makeDayFormatter, money } from '$lib/format';
	import type { QuotaResult, UsageResponse } from '$lib/types/usage';

	const REFRESH_MS = 5 * 60 * 1000;
	const SPARK_DAYS = 14;
	const SERIES = '#3987e5';

	let summary = $state<UsageResponse | null>(null);
	let quota = $state<QuotaResult | null>(null);
	let failed = $state(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	const zone = hostTimeZone();
	const dayOf = makeDayFormatter(zone);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`/api/usage?days=30&tz=${encodeURIComponent(zone)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			summary = (await res.json()) as UsageResponse;
			failed = false;
		} catch {
			failed = true;
		}
	}

	async function loadQuota(): Promise<void> {
		try {
			const res = await fetch('/api/usage/quota');
			if (res.ok) quota = (await res.json()) as QuotaResult;
		} catch {
			// The cost figures still stand without it.
		}
	}

	onMount(() => {
		void load();
		void loadQuota();
		timer = setInterval(() => {
			void load();
			void loadQuota();
		}, REFRESH_MS);
	});

	onDestroy(() => {
		if (timer !== null) clearInterval(timer);
	});

	function dayKey(offset: number): string {
		return dayOf(Date.now() - offset * 86_400_000);
	}

	const today = $derived.by(() => {
		if (!summary) return 0;
		const key = dayKey(0);
		return summary.days.find((d) => d.date === key)?.costUsd ?? 0;
	});

	/** Last two weeks, oldest first, gaps included so the rhythm stays honest. */
	const spark = $derived.by(() => {
		if (!summary) return [] as number[];
		const byDate = new Map(summary.days.map((d) => [d.date, d.costUsd]));
		const out: number[] = [];
		for (let i = SPARK_DAYS - 1; i >= 0; i--) out.push(byDate.get(dayKey(i)) ?? 0);
		return out;
	});

	const peak = $derived(Math.max(1e-9, ...spark));

</script>

<a class="usage-widget" href="/usage">
	{#if quota?.available}
		<QuotaBars {quota} compact />
	{/if}
	<div class="row">
		<span class="label">Today</span>
		<span class="value">{failed ? '—' : money(today, true)}</span>
	</div>
	{#if spark.length > 0}
		<div class="spark" aria-hidden="true">
			{#each spark as value, i (i)}
				<span class="tick" style="height: {Math.max(2, (value / peak) * 100)}%; background: {SERIES}"></span>
			{/each}
		</div>
	{/if}
	<div class="row sub">
		<span class="label">30 days</span>
		<span class="value">{failed ? '—' : money(summary?.costUsd ?? 0, true)}</span>
	</div>
</a>

<style>
	.usage-widget {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 8px 12px;
		border-top: 1px solid hsl(var(--border));
		background: hsl(var(--background));
		text-decoration: none;
		color: inherit;
	}

	.usage-widget:hover {
		background: rgba(255, 255, 255, 0.03);
	}

	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.label {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #a8a29e;
	}

	.value {
		font-size: 14px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.sub .value {
		font-size: 11px;
		font-weight: 500;
		color: #a8a29e;
	}

	.spark {
		display: flex;
		align-items: flex-end;
		gap: 1px;
		height: 22px;
	}

	.tick {
		flex: 1;
		border-radius: 1px;
		min-height: 2px;
		opacity: 0.85;
	}
</style>
