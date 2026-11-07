<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import MachineStrip from '$lib/components/workers/MachineStrip.svelte';
	import HistoryCharts from '$lib/components/workers/HistoryCharts.svelte';
	import { clock } from '$lib/stores/clock.svelte';
	import { apiBase, blockedReason, fleetStore, machineKey, machineName, sessionRef, type Machine } from '$lib/stores/fleet.svelte';
	import { sessionPath } from '$lib/session-route';
	import {
		RESULTS,
		issueKey,
		historyDays,
		historyTiles,
		mergeQueues,
		minutes,
		within,
		type QueuedIssue
	} from '$lib/workers';
	import type { QueueSettings, QueueStatus, WaitKind, WorkerRun, WorkerView } from '$shared/server/worker-queue.js';

	/**
	 * The Workers panel (#201): every machine as a strip of its memory with its
	 * limit, memory to keep and pause switch; the workers running and the
	 * issues queued, each saying why it waits; and how workers have run over 7,
	 * 30 or 90 days. Each machine's queue is read from that machine, through
	 * the relay for another one.
	 */

	onMount(() => fleetStore.start());

	interface MachineQueue {
		running: boolean;
		status: QueueStatus | null;
	}

	const machines = $derived(fleetStore.machines.filter((m) => m.server.id || m.local));
	const answering = $derived(machines.filter((m) => !blockedReason(m, clock.now)));
	let queues = $state<Record<string, MachineQueue>>({});
	let errors = $state<Record<string, string | null>>({});
	let histories = $state<Record<string, WorkerRun[]>>({});
	let busy = $state<Record<string, boolean>>({});
	let filter = $state<string>('all');
	let open = $state<string | null>(null);
	let period = $state<7 | 30 | 90>(30);
	/** Why a stop failed, under the worker it was for. */
	let said = $state<{ key: string; text: string } | null>(null);

	async function readQueue(m: Machine) {
		const key = machineKey(m);
		const res = await fetch(`${apiBase(m)}/api/queue`).catch(() => null);
		if (!res?.ok) {
			errors[key] = res?.status === 404 ? 'Runs a claude-mux without the worker queue' : 'Did not answer';
			return;
		}
		errors[key] = null;
		queues[key] = (await res.json()) as MachineQueue;
	}

	async function readHistory(m: Machine) {
		const res = await fetch(`${apiBase(m)}/api/queue/history`).catch(() => null);
		if (!res?.ok) return;
		histories[machineKey(m)] = ((await res.json()) as { runs: WorkerRun[] }).runs;
	}

	/** POST JSON to one of the machine's queue routes with its controls busy; the parsed body when it answered ok, else the error said. */
	async function post<T>(m: Machine, path: string, body: unknown): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
		const key = machineKey(m);
		busy[key] = true;
		try {
			const res = await fetch(`${apiBase(m)}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}).catch(() => null);
			const parsed = (await res?.json().catch(() => null)) as (T & { error?: string }) | null | undefined;
			return res?.ok && parsed ? { ok: true, body: parsed } : { ok: false, error: parsed?.error ?? 'Did not answer' };
		} finally {
			busy[key] = false;
		}
	}

	async function change(m: Machine, patch: Partial<QueueSettings>) {
		const res = await post<MachineQueue>(m, '/api/queue', patch);
		if (res.ok) {
			queues[machineKey(m)] = res.body;
			errors[machineKey(m)] = null;
		} else errors[machineKey(m)] = res.error;
	}

	/** The machine's one switch (`src/server/machine-switch.ts`), the same one the Machines view turns. */
	async function turn(m: Machine, on: boolean) {
		const res = await post<{ on: boolean }>(m, '/api/machine-switch', { on });
		if (res.ok) {
			errors[machineKey(m)] = null;
			await readQueue(m);
		} else errors[machineKey(m)] = res.error;
	}

	async function stop(m: Machine, w: WorkerView) {
		if (!confirm(`Stop the worker on #${w.number}? Its issue goes on hold, and its worktree is kept.`)) return;
		said = null;
		const res = await post<{ status?: QueueStatus }>(m, '/api/queue/stop', { repo: w.repo, number: w.number });
		if (res.ok && res.body.status) {
			queues[machineKey(m)] = { running: true, status: res.body.status };
			open = null;
			void readHistory(m);
		} else said = { key: issueKey(w), text: res.ok ? 'Did not answer' : res.error };
	}

	// Machines join as discovery finds them; each is read on its own key.
	const keys = $derived(answering.map(machineKey).join(' '));
	/** Read every answering machine now and every `ms` after, starting over when the machines change. */
	function pollEach(read: (m: Machine) => Promise<void>, ms: number) {
		$effect(() => {
			void keys;
			const readAll = () =>
				untrack(() => {
					for (const m of answering) void read(m);
				});
			readAll();
			const timer = setInterval(readAll, ms);
			return () => clearInterval(timer);
		});
	}
	pollEach(readQueue, 10_000);
	pollEach(readHistory, 60_000);

	const shown = $derived(answering.filter((m) => filter === 'all' || machineKey(m) === filter));
	/** The machines whose queue answered, each with its status. */
	const live = $derived(
		shown.flatMap((m) => {
			const st = queues[machineKey(m)]?.status;
			return st ? [{ m, st }] : [];
		})
	);

	interface RunningRow {
		key: string;
		m: Machine;
		w: WorkerView;
		doing: string;
		path: string | null;
	}
	const running = $derived<RunningRow[]>(
		live
			.flatMap(({ m, st }) =>
				st.workers.map((w) => {
					const s = w.sessionId ? m.sessions.find((x) => x.id === w.sessionId) : undefined;
					const doing = s ? (s.current_action ?? (s.state === 'idle' ? 'Idle at its prompt' : s.state)) : 'Starting';
					return { key: issueKey(w), m, w, doing, path: s ? sessionPath(sessionRef(m, s)) : null };
				})
			)
			.sort((a, b) => Number(b.w.wants) - Number(a.w.wants) || a.w.startedAt - b.w.startedAt)
	);
	const daemons = $derived(live.flatMap(({ m, st }) => st.others.map((o) => ({ m, o }))));
	const queued = $derived<QueuedIssue[]>(
		mergeQueues(live.map(({ m, st }) => ({ machine: machineName(m), waiting: st.waiting })))
	);

	const WHY_CLASS: Partial<Record<WaitKind, string>> = { memory: 'want', github: 'bad', slot: 'mid', off: 'mid' };

	const runs = $derived(
		within(
			shown.flatMap((m) => histories[machineKey(m)] ?? []),
			period,
			clock.now
		).sort((a, b) => b.endedAt - a.endedAt)
	);
	const days = $derived(historyDays(runs, period, clock.now));
	const tiles = $derived(historyTiles(runs));
	const RESULT = Object.fromEntries(RESULTS.map((r) => [r.result, r]));

	/** Dollars to the cent: a worker costs a few dollars, where `money()`'s third decimal is noise. */
	const usd = (v: number) => `$${v.toFixed(2)}`;
	const ago = (ms: number) => minutes((clock.now - ms) / 60_000);
	const projectOf = (repo: string) => repo.split('/')[1] ?? repo;
	const folderOf = (cwd: string | null) => cwd?.split('/').filter(Boolean).at(-1) ?? 'unknown';
</script>

<svelte:head><title>Workers · claude-mux</title></svelte:head>

<div class="workers">
	<header class="top">
		<div>
			<h1>Workers</h1>
			<p class="note">
				Issues you mark <code>ready-for-agent</code> in a project set to start sessions (on <a href="/events">Events</a>) wait here
				for a machine with room.
			</p>
		</div>
		<div class="filter" role="group" aria-label="Filter by machine">
			<Button size="sm" variant={filter === 'all' ? 'secondary' : 'ghost'} aria-pressed={filter === 'all'} onclick={() => (filter = 'all')}>
				All machines
			</Button>
			{#each answering as m (machineKey(m))}
				<Button
					size="sm"
					variant={filter === machineKey(m) ? 'secondary' : 'ghost'}
					aria-pressed={filter === machineKey(m)}
					onclick={() => (filter = machineKey(m))}
				>
					{machineName(m)}
				</Button>
			{/each}
		</div>
	</header>

	<section class="machines" aria-label="Machines">
		{#each shown as m (machineKey(m))}
			{@const key = machineKey(m)}
			{@const q = queues[key]}
			{#if errors[key]}
				<p class="machine-note"><b>{machineName(m)}</b> · {errors[key]}</p>
			{:else if q && (!q.running || !q.status)}
				<p class="machine-note"><b>{machineName(m)}</b> · Starts no workers: this server does not read GitHub.</p>
			{:else if q?.status}
				<MachineStrip
					name={machineName(m)}
					status={q.status}
					{open}
					busy={busy[key] === true}
					onOpen={(k) => (open = open === k ? null : k)}
					onChange={(patch) => void change(m, patch)}
					onTurn={(on) => void turn(m, on)}
				/>
			{:else}
				<p class="machine-note"><b>{machineName(m)}</b> · Reading…</p>
			{/if}
		{/each}
		{#each machines.filter((m) => blockedReason(m, clock.now)) as m (machineKey(m))}
			<p class="machine-note"><b>{machineName(m)}</b> · {blockedReason(m, clock.now)}</p>
		{/each}
		<div class="key">
			<span><i style:background="var(--w-other)"></i>Other sessions and apps</span>
			<span><i style:background="var(--w-busy)"></i>Worker, width is its memory</span>
			<span><i style:background="var(--w-want)"></i>Worker that wants you</span>
			<span><i class="line"></i>Nothing new starts past this line</span>
		</div>
	</section>

	<section class="work">
		<div>
			<div class="sec-head"><h2>Running</h2><span class="count">{running.length + daemons.length}</span></div>
			<div class="list">
				{#each running as r (r.key + machineKey(r.m))}
					<div class="item">
						<button type="button" class="row" aria-expanded={open === r.key} onclick={() => (open = open === r.key ? null : r.key)}>
							<span class="dot" class:wants={r.w.wants}></span>
							<span class="title">{r.w.title}</span>
							<span class="when">{ago(r.w.startedAt)}</span>
							<span class="sub">
								<b>{projectOf(r.w.repo)}</b> #{r.w.number} on {machineName(r.m)}
								{#if r.w.stopAtPr}<Badge variant="outline" class="ml-1">stops at PR</Badge>{/if}
							</span>
							{#if r.w.wants}<span class="sub want">Asked for help on its issue</span>{/if}
						</button>
						{#if open === r.key}
							<div class="detail">
								<dl class="facts">
									<div><dt>Doing now</dt><dd>{r.doing}</dd></div>
									<div><dt>Running for</dt><dd>{ago(r.w.startedAt)}</dd></div>
									<div>
										<dt>Memory</dt>
										<dd>
											{r.w.memGiB !== null ? `${r.w.memGiB.toFixed(1)} GiB` : '–'}{r.w.peakGiB ? `, peak ${r.w.peakGiB.toFixed(1)}` : ''}
										</dd>
									</div>
									<div><dt>Spent</dt><dd>{r.w.spendUsd != null ? usd(r.w.spendUsd) : '–'}</dd></div>
									<div><dt>Worktree</dt><dd class="mono">.worktree/{r.w.number}</dd></div>
									<div><dt>Ends with</dt><dd>{r.w.stopAtPr ? 'A PR for you to merge' : 'Its own merge'}</dd></div>
								</dl>
								<div class="acts">
									{#if r.path}<Button size="sm" variant="outline" href={r.path}>Open session</Button>{/if}
									<Button size="sm" variant="outline" href={r.w.url} target="_blank" rel="noopener">Open issue</Button>
									<Button size="sm" variant="outline" disabled={busy[machineKey(r.m)] === true} onclick={() => void stop(r.m, r.w)}>
										Stop worker
									</Button>
								</div>
								{#if said?.key === r.key}<p class="note" role="status">{said.text}</p>{/if}
							</div>
						{/if}
					</div>
				{/each}
				{#each daemons as d, i (machineKey(d.m) + i)}
					{@const s = d.o.sessionId ? d.m.sessions.find((x) => x.id === d.o.sessionId) : undefined}
					<div class="item">
						<a class="row" href={s ? sessionPath(sessionRef(d.m, s)) : undefined}>
							<span class="dot"></span>
							<span class="title">{s?.display_name ?? (d.o.issue !== null ? `Issue #${d.o.issue}` : 'A scheduled Run')}</span>
							<span class="when">{d.o.memGiB !== null ? `${d.o.memGiB.toFixed(1)} GiB` : ''}</span>
							<span class="sub"
								><b>{folderOf(d.o.cwd)}</b>{d.o.issue !== null ? ` #${d.o.issue}` : ''} on {machineName(d.m)}<Badge variant="outline" class="ml-1"
									>{d.o.issue !== null ? "a daemon's" : 'a Trigger'}</Badge
								></span
							>
						</a>
					</div>
				{/each}
				{#if running.length + daemons.length === 0}
					<p class="empty">Nothing running. Mark an issue <code>ready-for-agent</code> to start one.</p>
				{/if}
			</div>
		</div>
		<div>
			<div class="sec-head"><h2>Queue</h2><span class="count">{queued.length}</span></div>
			<div class="list">
				{#each queued as q (q.repo + q.number)}
					<div class="item">
						<div class="row static">
							<span class="dot wait"></span>
							<a class="title" href={q.url} target="_blank" rel="noopener">{q.title}</a>
							<span class="when">{q.since ? ago(q.since) : ''}</span>
							<span class="sub"><b>{projectOf(q.repo)}</b> #{q.number}</span>
							<span class="sub {WHY_CLASS[q.kind] ?? ''}">{q.why}{q.kind === 'slot' || q.kind === 'memory' || q.kind === 'off' ? ` on ${q.machine}` : ''}</span>
						</div>
					</div>
				{:else}
					<p class="empty">Queue is empty.</p>
				{/each}
			</div>
		</div>
	</section>

	<section>
		<div class="hist-top">
			<h2>How workers have run</h2>
			<div class="filter" role="group" aria-label="Period">
				{#each [7, 30, 90] as const as p (p)}
					<Button size="sm" variant={period === p ? 'secondary' : 'ghost'} aria-pressed={period === p} onclick={() => (period = p)}>
						{p} days
					</Button>
				{/each}
			</div>
		</div>
		<div class="tiles">
			<div class="tile"><strong>{tiles.finished}</strong><span>workers finished</span></div>
			<div class="tile"><strong>{tiles.mergedPct !== null ? `${tiles.mergedPct}%` : '–'}</strong><span>merged on their own</span></div>
			<div class="tile"><strong>{minutes(tiles.medianRun)}</strong><span>median run</span></div>
			<div class="tile"><strong>{tiles.peakGiB !== null ? `${tiles.peakGiB.toFixed(1)} GiB` : '–'}</strong><span>highest worker memory</span></div>
			<div class="tile"><strong>{usd(tiles.spendUsd)}</strong><span>spent</span></div>
		</div>
		<HistoryCharts {days} />
		<div class="runs">
			<div class="sec-head"><h2>Recent workers</h2></div>
			<div class="list">
				<div class="run head"><span>Result</span><span class="t">Worker</span><span class="r">Ran for</span><span class="r">Peak</span><span class="r">Spent</span></div>
				{#each runs.slice(0, 25) as r (r.machine + r.repo + r.number + r.endedAt)}
					<div class="run">
						<span class="st {r.result}">{RESULT[r.result].mark} {RESULT[r.result].label}</span>
						<span class="t">
							<a class="title" href={r.url} target="_blank" rel="noopener">{r.title}</a>
							<span class="when">{projectOf(r.repo)} #{r.number} · {r.machine}</span>
						</span>
						<span class="r when">{minutes((r.endedAt - r.startedAt) / 60_000)}</span>
						<span class="r when">{r.peakGiB !== null ? `${r.peakGiB.toFixed(1)} GiB` : '–'}</span>
						<span class="r when">{r.spendUsd !== null ? usd(r.spendUsd) : '–'}</span>
					</div>
				{:else}
					<p class="empty">No worker has finished in the last {period} days.</p>
				{/each}
			</div>
		</div>
	</section>
</div>

<style>
	.workers {
		--w-ground: #141210;
		--w-raised: #1d1a17;
		--w-line: #322d28;
		--w-ink: #f2efeb;
		--w-ink-2: #b4aea7;
		--w-ink-3: #8a837b;
		--w-busy: #34d399;
		--w-want: #fbbf24;
		--w-bad: #f87171;
		--w-other: #4a443d;
		--w-bar-ok: #1fa97a;
		--w-bar-want: #d39a1c;
		--w-bar-bad: #e0605a;
		--w-bar-other: #78716c;
		display: grid;
		gap: 28px;
		max-width: 1120px;
		margin: 0 auto;
		padding: 20px 16px 64px;
		color: var(--w-ink);
		font-size: 14px;
	}
	h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 600;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	code,
	.mono {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	a {
		color: inherit;
	}
	.note {
		margin: 2px 0 0;
		color: var(--w-ink-3);
		font-size: 13px;
	}
	.note a {
		text-decoration: underline;
	}
	.top,
	.hist-top {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: 12px;
	}
	.hist-top {
		margin-bottom: 14px;
	}
	.filter {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.machines {
		display: grid;
		gap: 10px;
	}
	.machine-note {
		margin: 0;
		padding: 12px 14px;
		border: 1px solid var(--w-line);
		border-radius: 8px;
		color: var(--w-ink-3);
	}
	.machine-note b {
		color: var(--w-ink);
		font-weight: 600;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		color: var(--w-ink-3);
		font-size: 12px;
	}
	.key i {
		display: inline-block;
		width: 10px;
		height: 10px;
		margin-right: 5px;
		border-radius: 2px;
		vertical-align: -1px;
	}
	.key i.line {
		width: 2px;
		background: var(--w-ink);
	}
	.work {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		align-items: start;
		gap: 24px;
	}
	.sec-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 8px;
	}
	.count {
		color: var(--w-ink-3);
		font-variant-numeric: tabular-nums;
	}
	.list {
		overflow: hidden;
		border: 1px solid var(--w-line);
		border-radius: 8px;
	}
	.item + .item,
	.run + .run {
		border-top: 1px solid var(--w-line);
	}
	.row {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 2px 8px;
		width: 100%;
		padding: 11px 12px;
		background: none;
		border: 0;
		color: inherit;
		font: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.row:hover {
		background: var(--w-raised);
	}
	.row.static {
		cursor: default;
	}
	.dot {
		align-self: center;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--w-busy);
	}
	.dot.wants {
		background: var(--w-want);
	}
	.dot.wait {
		background: none;
		border: 1.5px solid var(--w-ink-3);
	}
	.title {
		font-weight: 500;
		overflow-wrap: anywhere;
		text-decoration: none;
	}
	.when {
		color: var(--w-ink-3);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	.sub {
		grid-column: 2 / -1;
		color: var(--w-ink-3);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.sub b {
		color: var(--w-ink-2);
		font-weight: 500;
	}
	.sub.want {
		color: var(--w-want);
	}
	.sub.mid {
		color: var(--w-ink-2);
	}
	.sub.bad {
		color: var(--w-bad);
	}
	.detail {
		display: grid;
		gap: 10px;
		padding: 2px 12px 14px 34px;
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		gap: 8px 16px;
		margin: 0;
	}
	.facts dt {
		color: var(--w-ink-3);
		font-size: 12px;
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.empty {
		margin: 0;
		padding: 12px;
		color: var(--w-ink-3);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
		gap: 16px;
		margin-bottom: 16px;
	}
	.tile strong {
		display: block;
		font-size: 22px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	.tile span {
		color: var(--w-ink-3);
		font-size: 12px;
	}
	.runs {
		margin-top: 16px;
	}
	.run {
		display: grid;
		grid-template-columns: 130px minmax(0, 1fr) 70px 64px 64px;
		align-items: baseline;
		gap: 4px 12px;
		padding: 9px 12px;
	}
	.run.head {
		background: var(--w-raised);
		color: var(--w-ink-3);
		font-size: 12px;
	}
	.run .r {
		text-align: right;
	}
	.run .t .when {
		margin-left: 4px;
	}
	.st {
		font-size: 12px;
		white-space: nowrap;
	}
	.st.merged {
		color: var(--w-busy);
	}
	.st.help {
		color: var(--w-want);
	}
	.st.lost {
		color: var(--w-bad);
	}
	.st.stopped,
	.st.closed {
		color: var(--w-ink-2);
	}
	@media (max-width: 760px) {
		.work {
			grid-template-columns: minmax(0, 1fr);
		}
		/* No tables on a phone: each run is a row of its own. */
		.run.head {
			display: none;
		}
		.run {
			grid-template-columns: minmax(0, 1fr) auto auto auto;
		}
		.run .t {
			grid-column: 1 / -1;
			grid-row: 1;
		}
		.detail {
			padding-left: 12px;
		}
	}
</style>
