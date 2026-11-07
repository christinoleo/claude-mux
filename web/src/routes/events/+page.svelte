<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Toggle } from '$lib/components/ui/toggle';
	import { fleetPrefsStore } from '$lib/stores/fleet-prefs.svelte';
	import { nameList, placeName, placementKey } from '$shared/worker-placement.js';
	import type { QueueSettings, QueueStatus } from '$shared/server/worker-queue.js';
	import * as Tabs from '$lib/components/ui/tabs';
	import { clock } from '$lib/stores/clock.svelte';
	import { formatAgo } from '$lib/format';
	import { apiBase, blockedReason, fleetStore, machineKey, machineName, type Machine } from '$lib/stores/fleet.svelte';
	import type { EventAction, EventKind, EventProjectRow } from '$shared/db/event-map-json.js';
	import type { PollStatus, SeenEvent } from '$shared/server/github-events.js';

	/**
	 * The state map, one tab per machine (#183): the GitHub projects the
	 * machine holds, all off until enabled, and for each enabled one what an
	 * event does. Below, what the machine's poller has seen and what reading
	 * GitHub has cost it, and its worker queue (#200): the switch, limit and
	 * memory brake, the workers it started and why each ready issue waits.
	 * Everything is read from and written to the machine itself, through the
	 * relay for another one, except where a project's workers may run, which
	 * is a fleet preference and the same on every tab.
	 */

	onMount(() => fleetStore.start());

	interface MachineEvents {
		projects: EventProjectRow[];
		polling: boolean;
		status: PollStatus | null;
		log: SeenEvent[];
	}

	const EVENTS: { kind: EventKind; label: string }[] = [
		{ kind: 'issue-ready', label: 'Issue marked ready' },
		{ kind: 'push', label: 'Push to the default branch' }
	];
	const ACTIONS: { action: EventAction; label: string; title: string }[] = [
		{ action: 'ignore', label: 'Ignore', title: 'Nothing happens' },
		{ action: 'rule', label: 'Rule', title: 'Record that it was seen' },
		{ action: 'session', label: 'Session', title: 'Start a worker from the queue' }
	];

	interface MachineQueue {
		running: boolean;
		status: QueueStatus | null;
	}
	let queues = $state<Record<string, MachineQueue>>({});
	let queueErrors = $state<Record<string, string | null>>({});

	async function readQueue(m: Machine) {
		const key = machineKey(m);
		const res = await fetch(`${apiBase(m)}/api/queue`).catch(() => null);
		if (!res?.ok) {
			queueErrors[key] = res?.status === 404 ? 'This machine runs a claude-mux without the worker queue' : 'Did not answer';
			return;
		}
		queueErrors[key] = null;
		queues[key] = (await res.json()) as MachineQueue;
	}

	async function changeQueue(m: Machine, patch: Partial<QueueSettings>) {
		const key = machineKey(m);
		saving[`${key}/queue`] = true;
		try {
			const res = await fetch(`${apiBase(m)}/api/queue`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			}).catch(() => null);
			const body = (await res?.json().catch(() => null)) as (MachineQueue & { error?: string }) | null | undefined;
			if (res?.ok && body) {
				queues[key] = body;
				queueErrors[key] = null;
			} else queueErrors[key] = body?.error ?? 'Did not answer';
		} finally {
			saving[`${key}/queue`] = false;
		}
	}

	/** A number field's value, sent once it leaves the field and only when it is a number. */
	function numberChange(m: Machine, field: 'limit' | 'minFreeGiB' | 'maxPressure', raw: string) {
		const value = Number(raw);
		if (raw.trim() === '' || !Number.isFinite(value)) return;
		void changeQueue(m, { [field]: value });
	}

	/** Where a project's workers may run: the machines its list names, every one when it names none. */
	function placement(repo: string): string[] | null {
		return nameList(fleetPrefsStore.get<unknown>(placementKey(repo), null));
	}

	function togglePlacement(repo: string, name: string) {
		const have = placement(repo) ?? [];
		const next = have.includes(name) ? have.filter((n) => n !== name) : [...have, name];
		void fleetPrefsStore.set(placementKey(repo), next);
	}

	let data = $state<Record<string, MachineEvents>>({});
	let errors = $state<Record<string, string | null>>({});
	/** `machine/repo` while a write is under way. */
	let saving = $state<Record<string, boolean>>({});
	let selected = $state('');

	const machines = $derived(fleetStore.machines.filter((m) => m.server.id || m.local));
	$effect(() => {
		// A machine's key moves from its name to its id once discovery reports it.
		if (machines.length > 0 && !machines.some((m) => machineKey(m) === selected)) selected = machineKey(machines[0]);
	});
	const current = $derived(machines.find((m) => machineKey(m) === selected) ?? null);

	async function read(m: Machine) {
		const key = machineKey(m);
		const res = await fetch(`${apiBase(m)}/api/events`).catch(() => null);
		if (!res?.ok) {
			errors[key] = res?.status === 404 ? 'This machine runs a claude-mux without the state map' : 'Did not answer';
			return;
		}
		errors[key] = null;
		data[key] = (await res.json()) as MachineEvents;
	}

	async function change(m: Machine, repo: string, patch: { enabled?: boolean; events?: Partial<Record<EventKind, EventAction>> }) {
		const key = machineKey(m);
		saving[`${key}/${repo}`] = true;
		try {
			const res = await fetch(`${apiBase(m)}/api/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repo, ...patch })
			}).catch(() => null);
			const body = (await res?.json().catch(() => null)) as (MachineEvents & { error?: string }) | null | undefined;
			if (res?.ok && body) {
				data[key] = body;
				errors[key] = null;
			} else errors[key] = body?.error ?? 'Did not answer';
		} finally {
			saving[`${key}/${repo}`] = false;
		}
	}

	// The poller reads GitHub once a minute; the page follows it.
	// Keyed by the machine, not its object, which every broadcast replaces.
	const currentKey = $derived(current ? machineKey(current) : null);
	$effect(() => {
		if (!currentKey) return;
		const readCurrent = () =>
			untrack(() => {
				if (!current) return;
				void read(current);
				void readQueue(current);
			});
		readCurrent();
		const timer = setInterval(readCurrent, 15_000);
		return () => clearInterval(timer);
	});

	function statusLine(d: MachineEvents): string {
		if (!d.polling) return 'This server does not read GitHub (a dev server, unless started with CLAUDE_MUX_EVENTS=1).';
		const s = d.status;
		if (!s?.lastPollAt) return 'Not read yet. Projects are read once a minute after one is enabled.';
		const read = `Read ${formatAgo(s.lastPollAt, clock.now)}${s.viewer ? ` as @${s.viewer}` : ''}`;
		const spent = `${s.pointsLastHour} GraphQL ${s.pointsLastHour === 1 ? 'point' : 'points'} in the last hour over ${s.queriesLastHour} ${s.queriesLastHour === 1 ? 'query' : 'queries'}`;
		const left = s.remaining !== null ? `, ${s.remaining} left` : '';
		return `${read}. ${spent}${left}.${s.lastError ? ` Last read: ${s.lastError}.` : ''}`;
	}

	const KIND_LABEL: Record<EventKind, string> = { 'issue-ready': 'ready', push: 'push' };

	function memoryLine(q: QueueStatus): string {
		const free = q.memory.availableGiB !== null ? `${q.memory.availableGiB.toFixed(1)} GiB free` : 'free memory unknown';
		const pressure = q.memory.pressure !== null ? `, pressure ${q.memory.pressure.toFixed(1)}%` : '';
		return `${q.running} of ${q.settings.limit} running · ${free}${pressure}`;
	}
</script>

<svelte:head><title>Events · claude-mux</title></svelte:head>

<div class="events">
	<header>
		<h1>Events</h1>
		<p class="lede">
			What each machine does when GitHub changes in one of its projects. Every project is off until enabled here. An issue
			counts as ready only when you labelled it <code>ready-for-agent</code>; if someone else touches it after that, it waits
			in Needs you for your approval.
		</p>
	</header>

	<Tabs.Root bind:value={selected}>
		<Tabs.List>
			{#each machines as m (machineKey(m))}
				<Tabs.Trigger value={machineKey(m)} disabled={!m.online}>{machineName(m)}</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>

	{#if current}
		{@const key = machineKey(current)}
		{@const d = data[key]}
		{@const blocked = blockedReason(current, clock.now)}
		{#if errors[key]}<p class="error" role="status">{errors[key]}</p>{/if}
		{#if blocked}
			<p class="error" role="status">{blocked}</p>
		{:else if d}
			<p class="status">{statusLine(d)}</p>

			<section>
				<h2>Projects</h2>
				{#if d.projects.length === 0}
					<p class="quiet">No project on {machineName(current)} has a GitHub remote yet.</p>
				{/if}
				<ul class="projects">
					{#each d.projects as p (p.repo)}
						{@const busy = saving[`${key}/${p.repo}`] === true}
						<li class:on={p.enabled}>
							<div class="row1">
								<Checkbox
									checked={p.enabled}
									disabled={busy}
									aria-label="Act on GitHub events in {p.repo}"
									onCheckedChange={(on) => void change(current, p.repo, { enabled: on === true })}
								/>
								<span class="repo">{p.repo}</span>
								<span class="root" title={p.root}>{p.root}</span>
							</div>
							{#if p.enabled}
								{#each EVENTS as e (e.kind)}
									<div class="event">
										<span class="label">{e.label}</span>
										<span class="choices" role="radiogroup" aria-label="{e.label} in {p.repo}">
											{#each ACTIONS as a (a.action)}
												<Button
													size="sm"
													variant={p.events[e.kind] === a.action ? 'secondary' : 'ghost'}
													role="radio"
													aria-checked={p.events[e.kind] === a.action}
													title={a.title}
													disabled={busy || (a.action === 'session' && e.kind !== 'issue-ready')}
													onclick={() => void change(current, p.repo, { events: { [e.kind]: a.action } })}
												>
													{a.label}
												</Button>
											{/each}
										</span>
									</div>
								{/each}
								{#if p.events['issue-ready'] === 'session'}
									{@const placed = placement(p.repo)}
									<div class="event">
										<span class="label">Workers run on</span>
										<span class="choices" aria-label="Machines {p.repo}'s workers may run on">
											<!-- A machine whose name is not known yet cannot be named in a list. -->
											{#each machines.filter((pm) => pm.server.hostname) as pm (machineKey(pm))}
												{@const name = placeName(pm.server.hostname)}
												<Toggle
													size="sm"
													pressed={placed?.includes(name) ?? false}
													title={placed ? undefined : 'Any machine holding a checkout, while none is chosen'}
													onPressedChange={() => togglePlacement(p.repo, name)}
												>
													{machineName(pm)}
												</Toggle>
											{/each}
											{#if !placed}<span class="any">any</span>{/if}
										</span>
									</div>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			</section>

			{@const q = queues[key]}
			<section>
				<h2>Workers</h2>
				{#if queueErrors[key]}
					<p class="error" role="status">{queueErrors[key]}</p>
				{:else if !q}
					<p class="quiet">Reading…</p>
				{:else if !q.running || !q.status}
					<p class="quiet">This server starts no workers (it does not read GitHub).</p>
				{:else}
					{@const st = q.status}
					{@const busy = saving[`${key}/queue`] === true}
					<div class="row1">
						<Checkbox
							checked={st.settings.enabled}
							disabled={busy}
							aria-label="Start workers on {machineName(current)}"
							onCheckedChange={(on) => void changeQueue(current, { enabled: on === true })}
						/>
						<span class="repo">Start workers on {machineName(current)}</span>
					</div>
					<div class="settings">
						<label>
							<span>At most</span>
							<Input
								type="number"
								min="0"
								max="64"
								step="1"
								value={String(st.settings.limit)}
								disabled={busy}
								onchange={(ev) => numberChange(current, 'limit', ev.currentTarget.value)}
							/>
							<span>at once</span>
						</label>
						<label>
							<span>Hold a start under</span>
							<Input
								type="number"
								min="0"
								step="0.5"
								value={String(st.settings.minFreeGiB)}
								disabled={busy}
								onchange={(ev) => numberChange(current, 'minFreeGiB', ev.currentTarget.value)}
							/>
							<span>GiB free</span>
						</label>
						<label>
							<span>or over</span>
							<Input
								type="number"
								min="0"
								max="100"
								step="1"
								value={String(st.settings.maxPressure)}
								disabled={busy}
								onchange={(ev) => numberChange(current, 'maxPressure', ev.currentTarget.value)}
							/>
							<span>% memory pressure</span>
						</label>
					</div>
					<p class="status">
						{memoryLine(st)}{st.hold ? ` · ${st.hold}` : ''}{st.lastError ? ` · Last pass: ${st.lastError}` : ''}
					</p>
					{#if st.workers.length > 0}
						<ul class="log">
							{#each st.workers as w (w.repo + w.number)}
								<li>
									<span class="kind issue-ready">running</span>
									<a href={w.url} target="_blank" rel="noopener">#{w.number} {w.title}</a>
									<span class="when">{formatAgo(w.startedAt, clock.now)}</span>
									<span class="sub">{w.repo} · {w.target}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if st.waiting.length > 0}
						<h2>Waiting</h2>
						<ul class="log">
							{#each st.waiting as w (w.repo + w.number)}
								<li>
									<span class="kind">queued</span>
									<a href={w.url} target="_blank" rel="noopener">#{w.number} {w.title}</a>
									<span class="when"></span>
									<span class="sub">{w.repo} · {w.why}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if st.log.length > 0}
						<h2>Queue log</h2>
						<ul class="log">
							{#each st.log.slice(0, 20) as ev (ev.at + ev.repo + ev.number + ev.what)}
								<li>
									<span class="kind">#{ev.number}</span>
									<span class="what">{ev.what}</span>
									<span class="when">{formatAgo(ev.at, clock.now)}</span>
									<span class="sub">{ev.repo}</span>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</section>

			<section>
				<h2>Seen</h2>
				{#if d.log.length === 0}
					<p class="quiet">Nothing yet.</p>
				{:else}
					<ul class="log">
						{#each d.log as ev (ev.key + ev.at)}
							<li>
								<span class="kind {ev.kind}">{KIND_LABEL[ev.kind]}</span>
								<a href={ev.url} target="_blank" rel="noopener">{ev.title}</a>
								<span class="when">{formatAgo(ev.at, clock.now)}</span>
								<span class="sub">{ev.repo} · {ev.outcome}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{:else if !errors[key]}
			<p class="quiet">Reading…</p>
		{/if}
	{/if}
</div>

<style>
	.events {
		--ink: #f5f5f4;
		--ink-muted: #a8a29e;
		--ink-dim: #78716c;
		--line: #2a2a2c;
		max-width: 760px;
		margin: 0 auto;
		padding: 20px 16px 48px;
		color: var(--ink);
		font-size: 13px;
	}
	h1 {
		margin: 0 0 4px;
		font-size: 18px;
		font-weight: 600;
	}
	h2 {
		margin: 24px 0 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-muted);
	}
	.lede {
		margin: 0 0 16px;
		max-width: 64ch;
		color: var(--ink-muted);
		line-height: 1.5;
	}
	code {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.status {
		margin: 14px 0 0;
		color: var(--ink-muted);
	}
	.error {
		margin: 14px 0 0;
		color: #f87171;
	}
	.quiet {
		color: var(--ink-dim);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.projects li {
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
	}
	.row1 {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.repo {
		font-weight: 500;
	}
	.projects li:not(.on) .repo {
		color: var(--ink-muted);
	}
	.root {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink-dim);
		font-family: var(--font-mono);
		font-size: 11.5px;
		text-align: right;
	}
	.event {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 10px;
		margin: 6px 0 0 26px;
	}
	.event .label {
		flex: 1;
		min-width: 12em;
		color: var(--ink-muted);
	}
	.choices {
		display: inline-flex;
		gap: 2px;
	}
	.log li {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 2px 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--line);
	}
	.log a {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink);
	}
	.kind {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-dim);
	}
	.kind.issue-ready {
		color: #34d399;
	}
	.when {
		color: var(--ink-dim);
		font-size: 12px;
	}
	.what {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.any {
		align-self: center;
		padding: 0 6px;
		color: var(--ink-dim);
	}
	.settings {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
		margin: 10px 0 0 26px;
	}
	.settings label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--ink-muted);
	}
	.settings :global(input) {
		width: 5.5em;
		height: 28px;
	}
	.choices {
		flex-wrap: wrap;
	}
	.sub {
		grid-column: 2 / -1;
		color: var(--ink-dim);
		font-size: 12px;
	}
</style>
