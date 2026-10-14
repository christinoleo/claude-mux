<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { clock } from '$lib/stores/clock.svelte';
	import { apiBase, blockedReason, fleetStore, liveCount, machineName, offlineLabel, offlineReason, versionDrifts, type Machine } from '$lib/stores/fleet.svelte';
	import { browserIO, updateAll, updateMachine, updateOrder, type StepProgress } from '$lib/fleet-update';
	import { VERSION } from '$shared/utils/version.js';

	/**
	 * The Machines view: every machine in the fleet with its version, whether
	 * it answers, its live sessions, and an update button; "Update all" runs
	 * them in turn with this page's own machine last, since its restart takes
	 * the page's server with it (`$lib/fleet-update`).
	 */

	onMount(() => fleetStore.start());

	type Row = { id: string; origin: boolean; machine: Machine };

	/** In the order "Update all" takes them, so the list reads as the run. */
	const rows: Row[] = $derived(
		updateOrder(fleetStore.machines.map((m) => ({ id: m.server.id || m.server.hostname, origin: m.local, machine: m })))
	);

	let progress = $state<Record<string, StepProgress>>({});
	let runningAll = $state(false);
	/** Set when "Update all" finishes: what failed, in order. */
	let summary = $state<{ id: string; name: string; result: StepProgress }[] | null>(null);
	/** An update is under way, or queued behind one. */
	const busy = $derived(Object.values(progress).some((p) => p.state !== 'ok' && p.state !== 'failed'));
	/** This page's own machine came back on another version, so the page is stale. */
	const originUpdated = $derived(
		rows.some((r) => {
			const p = progress[r.id];
			return r.origin && p?.state === 'ok' && !!p.version && p.version !== VERSION;
		})
	);

	function runOne(row: Row): Promise<StepProgress> {
		return updateMachine(apiBase(row.machine), (p) => (progress[row.id] = p), browserIO);
	}

	async function updateOne(row: Row) {
		summary = null;
		await runOne(row);
	}

	async function updateEverything() {
		// An offline machine cannot be reached to update; it is reported with the failures.
		const skipped = rows.flatMap((r) => {
			const why = offlineReason(r.machine, clock.now);
			return why ? [{ id: r.id, name: machineName(r.machine), result: { state: 'failed', line: why, output: '', version: null } as StepProgress }] : [];
		});
		const todo = rows.filter((r) => !offlineReason(r.machine, clock.now));
		summary = null;
		runningAll = true;
		progress = Object.fromEntries(todo.map((r) => [r.id, { state: 'queued', line: 'Waiting its turn', output: '', version: null }]));
		try {
			const results = await updateAll(todo, runOne);
			summary = [
				...results.filter((r) => r.result.state === 'failed').map((r) => ({ id: r.machine.id, name: machineName(r.machine.machine), result: r.result })),
				...skipped
			];
		} finally {
			runningAll = false;
		}
	}

	function stateLabel(m: Machine): string {
		if (m.local) return 'this page’s machine';
		return m.online ? 'online' : offlineLabel(m, clock.now);
	}
</script>

<svelte:head><title>Machines · claude-mux</title></svelte:head>

<div class="machines">
	<header class="top">
		<div class="title">
			<h1>Machines</h1>
			<p class="lede">
				This page runs on {machineName(fleetStore.machines[0])}, claude-mux {VERSION}. Updates go one machine at a time,
				this one last.
			</p>
		</div>
		<Button onclick={() => void updateEverything()} disabled={busy || rows.length === 0}>
			<iconify-icon icon={runningAll ? 'mdi:loading' : 'mdi:update'} class:spin={runningAll}></iconify-icon>
			{runningAll ? 'Updating…' : 'Update all'}
		</Button>
	</header>

	<ol class="track" class:running={runningAll}>
		{#each rows as row (row.id)}
			{@const m = row.machine}
			{@const p = progress[row.id]}
			{@const blocked = blockedReason(m, clock.now)}
			{@const offline = offlineReason(m, clock.now)}
			{@const drift = versionDrifts(m)}
			<li class="station {p?.state ?? 'idle'}" class:off={!m.online}>
				<span class="node" aria-hidden="true">
					{#if p?.state === 'ok'}<iconify-icon icon="mdi:check"></iconify-icon>
					{:else if p?.state === 'failed'}<iconify-icon icon="mdi:close"></iconify-icon>
					{:else if p && p.state !== 'queued'}<iconify-icon icon="mdi:loading" class="spin"></iconify-icon>{/if}
				</span>
				<div class="body">
					<div class="line1">
						<span class="name">{machineName(m)}</span>
						<span class="ver" class:drift title={drift ? `Differs from this page’s ${VERSION}` : 'Same as this page'}>
							{m.version ?? 'version unknown'}
						</span>
						<span class="sessions">{liveCount(m)} live</span>
						<Button
							variant="outline"
							size="sm"
							class="upd"
							disabled={busy || !!offline}
							title={offline ?? `Run claude-mux update on ${machineName(m)}`}
							onclick={() => void updateOne(row)}
						>
							Update
						</Button>
					</div>
					<div class="line2">
						<span class="dot" class:on={m.online}></span>
						<span>{stateLabel(m)}</span>
						{#if row.origin}<span class="note">updated last; the page reconnects after</span>{/if}
					</div>
					{#if blocked && m.online}
						<p class="refused" role="status">{blocked}</p>
					{/if}
					{#if p}
						<p class="progress" class:failed={p.state === 'failed'}>
							{p.line}{#if p.state === 'ok' && p.version} — now {p.version}{/if}
						</p>
						{#if p.output && (p.state === 'failed' || p.state === 'running')}
							<details open={p.state === 'failed'}>
								<summary>Output</summary>
								<pre>{p.output}</pre>
							</details>
						{/if}
					{/if}
				</div>
			</li>
		{/each}
	</ol>

	{#if originUpdated}
		<div class="reload" role="status">
			{machineName(fleetStore.machines[0])} runs a new version now.
			<Button size="sm" variant="outline" onclick={() => location.reload()}>Reload the page</Button>
		</div>
	{/if}

	{#if summary}
		<section class="summary" aria-live="polite">
			{#if summary.length === 0}
				<p>Every machine updated.</p>
			{:else}
				<h2>{summary.length === 1 ? 'One machine' : `${summary.length} machines`} did not update</h2>
				{#each summary as f (f.id)}
					<div class="fail">
						<b>{f.name}</b>
						<span>{f.result.line}</span>
						{#if f.result.output}<pre>{f.result.output}</pre>{/if}
					</div>
				{/each}
			{/if}
		</section>
	{/if}
</div>

<style>
	.machines {
		--ink: #f5f5f4;
		--ink-muted: #a8a29e;
		--ink-dim: #78716c;
		--rail: #2e2c2a;
		--ok: #34d399;
		--bad: #f87171;
		max-width: 760px;
		margin: 0 auto;
		padding: 20px 16px 48px;
		color: var(--ink);
		font-size: 13px;
	}
	.top {
		display: flex;
		align-items: flex-start;
		gap: 16px;
		margin-bottom: 24px;
	}
	.title {
		flex: 1;
		min-width: 0;
	}
	h1 {
		margin: 0 0 4px;
		font-size: 18px;
		font-weight: 600;
	}
	.lede {
		margin: 0;
		max-width: 60ch;
		color: var(--ink-muted);
		line-height: 1.5;
	}

	/* The run as a track: each machine a station, in the order Update all
	   takes them, filled in as each one finishes. */
	.track {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.station {
		position: relative;
		display: flex;
		gap: 14px;
		padding-bottom: 18px;
	}
	.station::before {
		content: '';
		position: absolute;
		left: 8px;
		top: 20px;
		bottom: 0;
		width: 2px;
		background: var(--rail);
	}
	.station:last-child::before {
		display: none;
	}
	.station.ok::before {
		background: color-mix(in oklch, var(--ok) 55%, var(--rail));
	}
	.station.failed::before {
		background: color-mix(in oklch, var(--bad) 45%, var(--rail));
	}
	.node {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		margin-top: 1px;
		border-radius: 50%;
		border: 2px solid var(--rail);
		background: #1c1b1a;
		font-size: 12px;
	}
	.station.ok .node {
		border-color: var(--ok);
		color: var(--ok);
	}
	.station.failed .node {
		border-color: var(--bad);
		color: var(--bad);
	}
	.station.starting .node,
	.station.running .node,
	.station.restarting .node {
		border-color: var(--ink-muted);
		color: var(--ink);
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.line1 {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.station.off .name {
		color: var(--ink-muted);
	}
	.ver {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink-dim);
	}
	/* A version that differs from the page's is the one thing worth noticing. */
	.ver.drift {
		color: var(--ink);
		padding: 0 6px;
		border-radius: 5px;
		box-shadow: inset 0 0 0 1px #57534e;
	}
	.sessions {
		color: var(--ink-dim);
	}
	.line1 :global(.upd) {
		margin-left: auto;
		align-self: center;
	}
	.line2 {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 3px;
		color: var(--ink-muted);
		font-size: 12px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #3a3836;
	}
	.dot.on {
		background: var(--ok);
	}
	.note {
		color: var(--ink-dim);
	}
	.refused,
	.progress {
		margin: 6px 0 0;
		line-height: 1.45;
		color: var(--ink-muted);
		overflow-wrap: anywhere;
	}
	.refused {
		color: var(--ink);
	}
	.progress.failed {
		color: var(--bad);
	}
	details {
		margin-top: 6px;
	}
	summary {
		cursor: pointer;
		color: var(--ink-dim);
		font-size: 12px;
	}
	pre {
		margin: 6px 0 0;
		max-height: 220px;
		overflow: auto;
		padding: 8px 10px;
		border-radius: 6px;
		background: #141413;
		color: #d6d3d1;
		font-family: var(--font-mono);
		font-size: 11.5px;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.reload {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
		color: var(--ink-muted);
	}
	.summary {
		margin-top: 20px;
		padding-top: 14px;
		border-top: 1px solid var(--rail);
	}
	.summary p {
		margin: 0;
		color: var(--ok);
	}
	h2 {
		margin: 0 0 10px;
		font-size: 14px;
		font-weight: 600;
		color: var(--bad);
	}
	.fail {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 12px;
	}
	.fail span {
		color: var(--ink-muted);
	}
	.spin {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
	@media (max-width: 520px) {
		.top {
			flex-direction: column;
		}
	}
</style>
