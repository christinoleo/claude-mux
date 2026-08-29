<script lang="ts">
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { usageStore } from '$lib/stores/usage.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { wakeLockSupported } from '$lib/wakeLock.svelte';
	import { hostTimeZone, makeDayFormatter, money } from '$lib/format';
	import { SEVERITY, severityForPercent } from '$lib/severity';

	const SPARK_DAYS = 14;
	/** Why the plan columns are missing, for the one place there is room to say it. */
	const PLAN_UNAVAILABLE = 'Plan limits unavailable — open Usage for the reason.';
	const SERIES = '#3987e5';

	// The store owns the polling, so the sidebar and the composer's key share
	// one pair of requests rather than each running their own timer.
	$effect(() => usageStore.subscribe());

	const dayOf = makeDayFormatter(hostTimeZone());
	const supported = wakeLockSupported();

	const summary = $derived(usageStore.summary);
	const quota = $derived(usageStore.quota);
	const today = $derived(usageStore.today);
	const stats = $derived(sessionStore.systemStats);

	interface Meter {
		key: string;
		/** Two or three characters — the column is only as wide as its bar. */
		tag: string;
		percent: number;
		color: string;
		title: string;
	}

	/** Labels share a length so the columns can share a width. */
	function shortLabel(label: string): string {
		const text = label.toLowerCase();
		if (text.includes('session')) return '5h';
		const model = text.match(/(opus|sonnet|haiku|fable|mythos)/)?.[1];
		if (model) return model.slice(0, 3);
		if (text.includes('week')) return 'wk';
		return text.replace(/\s*limit$/, '').split(/\s+/)[0];
	}

	const meters = $derived.by(() => {
		const out: Meter[] = [];
		for (const limit of quota?.available ? quota.limits : []) {
			out.push({
				key: limit.kind,
				tag: shortLabel(limit.label),
				percent: limit.percent,
				// The server grades plan limits itself, and the sidebar shows that
				// grade — recomputing here is how the two start disagreeing.
				color: SEVERITY[limit.severity].color,
				title: `${limit.label}: ${Math.round(limit.percent)}%`
			});
		}
		const system: Array<[string, string, number]> = [
			['cpu', 'cpu', stats.cpu],
			['ram', 'ram', stats.ram]
		];
		if (stats.swapTotal > 0) system.push(['swap', 'swp', stats.swap]);
		for (const [key, tag, percent] of system) {
			out.push({
				key,
				tag,
				percent,
				color: SEVERITY[severityForPercent(percent)].color,
				title: `${tag.toUpperCase()}: ${Math.round(percent)}%`
			});
		}
		return out;
	});

	function dayKey(offset: number): string {
		return dayOf(Date.now() - offset * 86_400_000);
	}

	/** Last two weeks, oldest first, gaps included so the rhythm stays honest. */
	const spark = $derived.by(() => {
		if (!summary) return [] as Array<{ date: string; cost: number }>;
		const byDate = new Map(summary.days.map((d) => [d.date, d.costUsd]));
		const out: Array<{ date: string; cost: number }> = [];
		for (let i = SPARK_DAYS - 1; i >= 0; i--) {
			const date = dayKey(i);
			out.push({ date, cost: byDate.get(date) ?? 0 });
		}
		return out;
	});

	const peak = $derived(Math.max(1e-9, ...spark.map((d) => d.cost)));
</script>

<!--
	Every sidebar number is a share of something, so every one of them is the
	same column: a reading on top, a bar that fills upwards, a label under it.
	Standing them side by side costs one row of height for the whole set, where
	a stack of horizontal meters spent a row on each.
-->
<div class="sidebar-meters">
	<a class="strip" href="/usage" title={quota && !quota.available ? PLAN_UNAVAILABLE : undefined}>
		{#if meters.length > 0}
			<span class="group">
				{#each meters as meter (meter.key)}
					<span class="col" title={meter.title}>
						<span class="val" style="color: {meter.color}">{Math.round(meter.percent)}%</span>
						<span class="track" role="img" aria-label={meter.title}>
							<span
								class="fill"
								style="height: {Math.min(100, Math.max(0, meter.percent))}%; background: {meter.color}"
							></span>
						</span>
						<span class="tag">{meter.tag}</span>
					</span>
				{/each}
			</span>
		{/if}

		{#if spark.length > 0}
			<span class="group spark">
				<!-- The two figures frame the fortnight they are drawn from: today at
				     the left, where the reading starts, the whole month's total at the
				     right. The thirteen days between them stay a shape — fourteen
				     numbers at this size would be a smear. -->
				<span class="line">
					<span class="val spend">{today === null ? '—' : money(today, true)}</span>
					<span class="val spend">{summary === null ? '—' : money(summary.costUsd, true)}</span>
				</span>
				<span class="ticks" aria-hidden="true">
					{#each spark as day (day.date)}
						<span class="track" title="{day.date}: {money(day.cost, true)}">
							<span
								class="fill"
								style="height: {Math.max(3, (day.cost / peak) * 100)}%; background: {SERIES}"
							></span>
						</span>
					{/each}
				</span>
				<span class="line">
					<span class="tag">today</span>
					<span class="tag">30d</span>
				</span>
			</span>
		{/if}
	</a>

	{#if supported}
		<label class="awake-row">
			<input
				type="checkbox"
				checked={preferences.keepAwake}
				onchange={(e) => (preferences.keepAwake = e.currentTarget.checked)}
			/>
			<span>Keep screen on</span>
		</label>
	{/if}
</div>

<style>
	.sidebar-meters {
		padding: 8px 12px;
		border-top: 1px solid hsl(var(--border));
		background: hsl(var(--background));
	}

	.strip {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 6px 10px;
		text-decoration: none;
		color: inherit;
		margin: -4px -6px;
		padding: 4px 6px;
		border-radius: 6px;
	}

	.strip:hover {
		background: rgba(255, 255, 255, 0.03);
	}

	.group {
		display: flex;
		align-items: flex-end;
		gap: 3px;
		min-width: 0;
	}

	/* The spend history is the one group that can give up width: its bars are a
	   shape, not a set of readings, so squeezing them loses nothing. */
	.spark {
		flex: 1 1 auto;
		/* Never narrower than the two figures it carries, and no wider a floor
		   than that — one pixel more and the strip wraps at the default width. */
		min-width: 96px;
		flex-direction: column;
		align-items: stretch;
		gap: 3px;
	}

	.ticks {
		display: flex;
		align-items: flex-end;
		gap: 1px;
		height: 26px;
	}

	/* Spend has no ceiling, so its columns get no track: a groove behind them
	   would promise a full mark that does not exist. */
	.ticks .track {
		flex: 1 1 0;
		min-width: 2px;
		background: transparent;
	}

	.col {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		/* Wide enough for the widest thing above it — "100%" — so neither the
		   readings nor the tags lean into their neighbours'. */
		min-width: 21px;
	}

	.val {
		font-size: 9px;
		line-height: 1;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.val.spend {
		font-size: 11px;
		color: hsl(var(--foreground));
	}

	/* The figure and the label at each end of the sparkline. */
	.line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
	}

	.track {
		position: relative;
		display: block;
		width: 7px;
		height: 26px;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.08);
		overflow: hidden;
	}

	.fill {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		border-radius: 2px;
		transition: height 600ms ease;
	}

	.tag {
		font-size: 9px;
		line-height: 1;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #a8a29e;
		white-space: nowrap;
	}

	.awake-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		cursor: pointer;
		user-select: none;
	}

	.awake-row input {
		margin: 0;
		cursor: pointer;
	}
</style>
