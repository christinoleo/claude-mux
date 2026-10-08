<script lang="ts">
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { usageStore } from '$lib/stores/usage.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { wakeLockSupported } from '$lib/wakeLock.svelte';
	import { hostTimeZone, makeDayFormatter, money } from '$lib/format';
	import { SEVERITY, severityForPercent } from '$lib/severity';
	import { unlockNotificationAudio } from '$lib/notifications';
	import {
		hasDesktopNotifications,
		hasNotificationSound,
		type NotificationMode
	} from '$shared/session-notifications.js';

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

	const MODES: Array<{ value: NotificationMode; label: string; title: string }> = [
		{ value: 'off', label: 'Off', title: 'No system notifications or sounds' },
		{ value: 'notifications', label: 'Notify', title: 'System notifications while this window is in the background' },
		{ value: 'sound', label: 'Sound', title: 'A sound when a session needs you or finishes' },
		{ value: 'both', label: 'Both', title: 'System notifications and sounds' }
	];

	/** Why the last choice did not take, shown under the control. */
	let alertProblem = $state<string | null>(null);
	let requesting = $state(false);

	async function chooseMode(value: NotificationMode): Promise<void> {
		alertProblem = null;
		if (hasNotificationSound(value)) unlockNotificationAudio();
		if (hasDesktopNotifications(value)) {
			if (!window.isSecureContext) {
				alertProblem =
					'System notifications need HTTPS. Open claude-mux through tailscale serve; sound works either way.';
				return;
			}
			if (typeof Notification === 'undefined') {
				alertProblem = 'This browser has no system notifications. Sound works either way.';
				return;
			}
			requesting = true;
			try {
				if ((await Notification.requestPermission()) !== 'granted') {
					alertProblem = 'Notifications are blocked. Allow them in the browser’s site settings, then choose again.';
					return;
				}
			} catch {
				alertProblem = 'This browser refused to show notifications. Sound works either way.';
				return;
			} finally {
				requesting = false;
			}
		}
		preferences.notificationMode = value;
	}
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

	<div class="alerts-row">
		<span class="alerts-label" id="alerts-label">Alerts</span>
		<div class="segmented" role="radiogroup" aria-labelledby="alerts-label">
			{#each MODES as m (m.value)}
				<button
					type="button"
					role="radio"
					aria-checked={preferences.notificationMode === m.value}
					class:on={preferences.notificationMode === m.value}
					title={m.title}
					disabled={requesting}
					onclick={() => chooseMode(m.value)}
				>
					{m.label}
				</button>
			{/each}
		</div>
	</div>
	{#if alertProblem}
		<p class="alerts-problem" role="status">{alertProblem}</p>
	{/if}

	<div class="toggles">
		<label class="toggle-row" title="A toast in this page when another session needs you or finishes">
			<input
				type="checkbox"
				checked={preferences.inAppToasts}
				onchange={(e) => (preferences.inAppToasts = e.currentTarget.checked)}
			/>
			<span>In-page toasts</span>
		</label>
		{#if supported}
			<label class="toggle-row">
				<input
					type="checkbox"
					checked={preferences.keepAwake}
					onchange={(e) => (preferences.keepAwake = e.currentTarget.checked)}
				/>
				<span>Keep screen on</span>
			</label>
		{/if}
	</div>
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

	.alerts-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-top: 8px;
		font-size: 11px;
		color: hsl(var(--muted-foreground));
	}

	/* Four choices of one setting, so one control rather than four checkboxes. */
	.segmented {
		display: inline-flex;
		padding: 2px;
		gap: 2px;
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid #2a2a2c;
	}

	.segmented button {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 11px;
		line-height: 1;
		padding: 4px 7px;
		border-radius: 5px;
		cursor: pointer;
	}

	.segmented button:hover:not(.on) {
		color: hsl(var(--foreground));
	}

	.segmented button.on {
		background: rgba(255, 255, 255, 0.1);
		color: hsl(var(--foreground));
	}

	.segmented button:focus-visible {
		outline: 1px solid #818cf8;
		outline-offset: 1px;
	}

	.segmented button:disabled {
		cursor: progress;
	}

	.alerts-problem {
		margin: 6px 0 0;
		font-size: 11px;
		line-height: 1.35;
		color: #fbbf24;
	}

	.toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin-top: 6px;
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		cursor: pointer;
		user-select: none;
	}

	.toggle-row input {
		margin: 0;
		cursor: pointer;
	}
</style>
