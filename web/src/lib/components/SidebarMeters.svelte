<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Popover from '$lib/components/ui/popover';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { fleetStore, machineKey, machineName } from '$lib/stores/fleet.svelte';
	import { machineMarks } from '$shared/fleet-rail.js';
	import { spendCoverage } from '$shared/usage/coverage.js';
	import { usageStore } from '$lib/stores/usage.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { wakeLockSupported } from '$lib/wakeLock.svelte';
	import { hostTimeZone, makeDayFormatter, money } from '$lib/format';
	import { SEVERITY, severityForPercent, type Severity } from '$lib/severity';
	import {
		hasDesktopNotifications,
		hasNotificationSound,
		unlockNotificationAudio,
		type NotificationMode
	} from '$lib/notifications';
	import {
		keepSubscriptionCurrent,
		pushUnavailable,
		saveEvents,
		sendTestPush,
		subscribe,
		unsubscribe,
		type PushEvents
	} from '$lib/push';

	interface Props {
		/** What belongs to the session on screen, drawn first on the top line. */
		lead?: Snippet;
	}

	let { lead }: Props = $props();

	const SPARK_DAYS = 14;
	/** Why the plan columns are missing, for the one place there is room to say it. */
	const PLAN_UNAVAILABLE = 'Plan limits unavailable. Open Usage for the reason.';

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
		/** Two or three characters, so the bars line up under their readings. */
		tag: string;
		percent: number;
		color: string;
		title: string;
	}

	/** Labels share a length so the bars can share a width. */
	function shortLabel(label: string): string {
		const text = label.toLowerCase();
		if (text.includes('session')) return '5h';
		const model = text.match(/(opus|sonnet|haiku|fable|mythos)/)?.[1];
		if (model) return model.slice(0, 3);
		if (text.includes('week')) return 'wk';
		return text.replace(/\s*limit$/, '').split(/\s+/)[0];
	}

	const plan = $derived(
		(quota?.available ? quota.limits : []).map(
			(limit): Meter => ({
				key: limit.kind,
				tag: shortLabel(limit.label),
				percent: limit.percent,
				// The server grades plan limits itself, and the sidebar shows that
				// grade: recomputing here is how the two start disagreeing.
				color: SEVERITY[limit.severity].color,
				title: `${limit.label}: ${Math.round(limit.percent)}%`
			})
		)
	);

	const system = $derived.by(() => {
		const rows: Array<[string, number, Severity]> = [
			['cpu', stats.cpu, severityForPercent(stats.cpu)],
			['ram', stats.ram, severityForPercent(stats.ram)]
		];
		// A disk that could not be read draws no bar rather than an empty one.
		if (stats.disk !== null) rows.push(['dsk', stats.disk, severityForPercent(stats.disk, 'disk')]);
		if (stats.swapTotal > 0) rows.push(['swp', stats.swap, severityForPercent(stats.swap)]);
		return rows.map(
			([tag, percent, severity]): Meter => ({
				key: tag,
				tag,
				percent,
				color: SEVERITY[severity].color,
				title: `${tag === 'dsk' ? 'Disk (home)' : tag.toUpperCase()}: ${Math.round(percent)}%`
			})
		);
	});

	/** The machine that served the page, named and coloured as its rows are in the drawer. */
	const origin = $derived.by(() => {
		const marks = machineMarks(
			fleetStore.machines.map((m) => ({ id: machineKey(m), name: machineName(m) }))
		);
		const self = fleetStore.machines.find((m) => m.local);
		return self ? marks.get(machineKey(self)) : undefined;
	});

	/** Whose spend the fleet total holds, so a total missing a machine says so. */
	const coverage = $derived(summary ? spendCoverage(summary.machines) : null);

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
	// A permission revoked since the choice was made silences the alerts, so say so.
	$effect(() => {
		if (
			hasDesktopNotifications(preferences.notificationMode) &&
			typeof Notification !== 'undefined' &&
			Notification.permission !== 'granted'
		)
			alertProblem = 'Notifications are blocked. Allow them in the browser’s site settings, then choose again.';
	});
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

	// Web Push reaches this device with every claude-mux tab closed. The
	// browser holds the subscription; the server holds which events it takes.
	let pushSub = $state<PushSubscription | null>(null);
	let pushEvents = $state<PushEvents>({ needsYou: true, done: true });
	let pushBusy = $state(false);
	/** What the last push action said: a problem, or that the test went out. */
	let pushNote = $state<{ text: string; problem: boolean } | null>(null);
	const pushBlocked = typeof window === 'undefined' ? null : pushUnavailable();

	$effect(() => {
		if (pushBlocked) return;
		void (async () => {
			// A subscription the fleet forgot (its push service said the device
			// was gone, or it was turned off elsewhere) cannot be reached, so it
			// counts as off. One under an old key is renewed on the way.
			const known = await keepSubscriptionCurrent();
			pushSub = known?.subscription ?? null;
			if (known) pushEvents = known.events;
		})().catch(() => {});
	});

	async function pushAction(run: () => Promise<string | void>): Promise<void> {
		pushBusy = true;
		pushNote = null;
		try {
			const done = await run();
			if (done) pushNote = { text: done, problem: false };
		} catch (err) {
			pushNote = { text: err instanceof Error ? err.message : String(err), problem: true };
		} finally {
			pushBusy = false;
		}
	}

	function setPush(on: boolean): Promise<void> {
		return pushAction(async () => {
			if (on && !pushSub) pushSub = await subscribe(pushEvents);
			else if (!on && pushSub) {
				await unsubscribe(pushSub);
				pushSub = null;
			}
		});
	}

	function setPushEvent(key: keyof PushEvents, value: boolean): Promise<void> {
		const sub = pushSub;
		if (!sub) return Promise.resolve();
		return pushAction(async () => {
			pushEvents = await saveEvents(sub, { ...pushEvents, [key]: value });
		});
	}

	function testPush(): Promise<void> {
		const sub = pushSub;
		if (!sub) return Promise.resolve();
		return pushAction(async () => {
			await sendTestPush(sub);
			return 'Sent. It should arrive in a few seconds.';
		});
	}
</script>

<!--
	The foot is flush with the drawer, three labelled rows under one hairline:
	what the plan allows, what the machine that served the page is carrying,
	and what the fleet has spent. Settings sit behind the gear, since they are
	set once and read seldom.
-->
<div class="sidebar-meters">
	<div class="top">
		{@render lead?.()}
		<span class="top-end">
			<a class="icon-button" href="/usage" title="Usage" aria-label="Usage">
				<iconify-icon icon="mdi:chart-box-outline"></iconify-icon>
			</a>
			<Popover.Root>
				<Popover.Trigger class="icon-button" title="Alerts and this device" aria-label="Alerts and this device">
					<iconify-icon icon="mdi:cog-outline"></iconify-icon>
					{#if alertProblem}
						<!-- The settings are folded away, so a choice that stopped working says so here. -->
						<span class="problem-dot" title={alertProblem}></span>
					{/if}
				</Popover.Trigger>
				<Popover.Content
					side="top"
					align="end"
					sideOffset={8}
					class="w-72 max-w-[90vw] border-[#333] bg-[#1a1a1a] p-3"
				>
					{@render settings()}
				</Popover.Content>
			</Popover.Root>
		</span>
	</div>

	<div class="row">
		<span class="label">Plan</span>
		{#if plan.length > 0}
			<span class="bars">
				{#each plan as meter (meter.key)}
					{@render bar(meter)}
				{/each}
			</span>
		{:else if quota && !quota.available}
			<a class="quiet" href="/usage" title={PLAN_UNAVAILABLE}>unavailable</a>
		{:else}
			<span class="quiet">—</span>
		{/if}
	</div>

	<div class="row">
		<span class="label machine" style:color={origin?.color} title="The machine that served this page">
			{origin?.name ?? 'this machine'}
		</span>
		<span class="bars">
			{#each system as meter (meter.key)}
				{@render bar(meter)}
			{/each}
		</span>
	</div>

	{#if spark.length > 0}
		<div class="row spend-row">
			<span class="label">Spend</span>
			<span class="spend">
				<span class="line">
					<span class="figure">{today === null ? '—' : money(today, true)} <span class="tag">today</span></span>
					{#if coverage && coverage.total > 1}
						<span
							class="coverage"
							class:short={coverage.answered < coverage.total}
							title={coverage.missing.length ? `No answer from ${coverage.missing.join(', ')}` : 'Every machine answered'}
						>
							{coverage.answered} of {coverage.total} {coverage.total === 1 ? 'machine' : 'machines'}
						</span>
					{/if}
					<span class="figure">{money(summary!.costUsd, true)} <span class="tag">30d</span></span>
				</span>
				<!-- Fourteen days as a shape: fourteen numbers at this size would be a smear. -->
				<span class="ticks" aria-hidden="true">
					{#each spark as day (day.date)}
						<span class="tick" title="{day.date}: {money(day.cost, true)}">
							<span class="tick-fill" style="height: {Math.max(8, (day.cost / peak) * 100)}%"></span>
						</span>
					{/each}
				</span>
			</span>
		</div>
	{/if}
</div>

{#snippet bar(meter: Meter)}
	<span class="meter" title={meter.title}>
		<span class="reading">
			<span class="tag">{meter.tag}</span>
			<span class="val" style:color={meter.color}>{Math.round(meter.percent)}%</span>
		</span>
		<span class="track" role="img" aria-label={meter.title}>
			<span
				class="fill"
				style="width: {Math.min(100, Math.max(0, meter.percent))}%; background: {meter.color}"
			></span>
		</span>
	</span>
{/snippet}

{#snippet settings()}
	<div class="settings">
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

		<div class="alerts-row">
			<span
				class="alerts-label"
				id="push-label"
				title="Notifications on this device with claude-mux closed, sent by the server"
			>
				Push
			</span>
			<div class="segmented" role="radiogroup" aria-labelledby="push-label">
				{#each [false, true] as on (on)}
					<button
						type="button"
						role="radio"
						aria-checked={!!pushSub === on}
						class:on={!!pushSub === on}
						disabled={pushBusy || !!pushBlocked}
						onclick={() => setPush(on)}
					>
						{on ? 'This device' : 'Off'}
					</button>
				{/each}
			</div>
		</div>
		{#if pushBlocked}
			<p class="alerts-note">{pushBlocked}</p>
		{:else if pushSub}
			<div class="toggles">
				<label class="toggle-row" title="A session asks a question or wants an approval">
					<input
						type="checkbox"
						checked={pushEvents.needsYou}
						disabled={pushBusy}
						onchange={(e) => setPushEvent('needsYou', e.currentTarget.checked)}
					/>
					<span>Needs you</span>
				</label>
				<label class="toggle-row" title="A session finished its turn">
					<input
						type="checkbox"
						checked={pushEvents.done}
						disabled={pushBusy}
						onchange={(e) => setPushEvent('done', e.currentTarget.checked)}
					/>
					<span>Done</span>
				</label>
				<button type="button" class="link-button" disabled={pushBusy} onclick={testPush}>Send a test</button>
			</div>
		{/if}
		{#if pushNote}
			<p class={pushNote.problem ? 'alerts-problem' : 'alerts-note'} role="status">{pushNote.text}</p>
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
{/snippet}

<style>
	.sidebar-meters {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 6px 12px 10px;
		border-top: 1px solid hsl(var(--border));
		background: hsl(var(--background));
	}

	.top {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 24px;
	}

	.top-end {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
	}

	.top :global(.icon-button) {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 24px;
		height: 24px;
		padding: 0 4px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: hsl(var(--muted-foreground));
		cursor: pointer;
	}

	.top :global(.icon-button:hover),
	.top :global(.icon-button[data-state='open']) {
		background: rgba(255, 255, 255, 0.06);
		color: hsl(var(--foreground));
	}

	.problem-dot {
		position: absolute;
		top: 3px;
		right: 3px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #fbbf24;
	}

	.top :global(.icon-button iconify-icon) {
		font-size: 15px;
	}

	/* A row is its label, then its readings; the label column is shared so the
	   three rows start their bars at one edge. */
	.row {
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr);
		align-items: end;
		gap: 8px;
	}

	/* The spend row's label sits with its figures, not under the sparkline. */
	.spend-row {
		align-items: start;
	}

	.label {
		font-size: 11px;
		line-height: 1.2;
		color: hsl(var(--muted-foreground));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding-bottom: 1px;
	}

	.label.machine {
		font-weight: 600;
	}

	.quiet {
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		text-decoration: none;
	}

	a.quiet:hover {
		color: hsl(var(--foreground));
		text-decoration: underline;
	}

	.bars {
		display: flex;
		gap: 8px;
		min-width: 0;
	}

	.meter {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.reading {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 4px;
		line-height: 1;
	}

	.tag {
		font-size: 10px;
		color: #a8a29e;
		white-space: nowrap;
	}

	.val {
		font-size: 10px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.track {
		position: relative;
		display: block;
		height: 3px;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.08);
		overflow: hidden;
	}

	.fill {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		border-radius: 2px;
		transition: width 600ms ease;
	}

	.spend {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 6px;
		line-height: 1;
	}

	.figure {
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: hsl(var(--foreground));
		white-space: nowrap;
	}

	.coverage {
		font-size: 10px;
		color: hsl(var(--muted-foreground));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.coverage.short {
		color: #fbbf24;
	}

	/* Spend has no ceiling, so its ticks get no track: a groove behind them
	   would promise a full mark that does not exist. */
	.ticks {
		display: flex;
		align-items: flex-end;
		gap: 1px;
		height: 16px;
	}

	.tick {
		flex: 1 1 0;
		min-width: 2px;
		height: 100%;
		display: flex;
		align-items: flex-end;
	}

	.tick-fill {
		width: 100%;
		border-radius: 1px;
		background: #3987e5;
		transition: height 600ms ease;
	}

	/* Each setting under the one before it; a note or a set of toggles hangs
	   closer to the control it belongs to. */
	.settings {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.alerts-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
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
		margin: -4px 0 0;
		font-size: 11px;
		line-height: 1.35;
		color: #fbbf24;
	}

	.alerts-note {
		margin: -4px 0 0;
		font-size: 11px;
		line-height: 1.35;
		color: hsl(var(--muted-foreground));
	}

	.link-button {
		margin-left: auto;
		border: 0;
		padding: 0;
		background: none;
		font: inherit;
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.link-button:hover:not(:disabled) {
		color: hsl(var(--foreground));
	}

	.link-button:disabled {
		cursor: progress;
	}

	.toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
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
