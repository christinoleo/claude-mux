<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Toggle } from '$lib/components/ui/toggle';
	import * as Tabs from '$lib/components/ui/tabs';
	import { clock } from '$lib/stores/clock.svelte';
	import { formatAgo } from '$lib/format';
	import { apiBase, blockedReason, fleetStore, machineKey, machineName, type Machine } from '$lib/stores/fleet.svelte';
	import { pastPath, sessionPath } from '$lib/session-route';
	import type { RunStatus, RunView, TriggerAction, TriggerView } from '$shared/server/triggers.js';
	import { DAY_NAMES, UNITS, type Schedule, type Unit } from '$shared/trigger-schedule.js';

	/**
	 * The Triggers screen (#202, decided in #184 and #166), one tab per
	 * machine: each Trigger with its next firing and a pause button, a short
	 * form for a new clock Trigger, and each Trigger's Runs, run or skipped,
	 * with the reason and a link to the session or the issue. Event Triggers
	 * come from the state map and are changed on the Events screen.
	 */

	onMount(() => fleetStore.start());

	interface MachineTriggers {
		running: boolean;
		lastError: string | null;
		triggers: TriggerView[];
		projects: { repo: string; root: string }[];
	}

	let data = $state<Record<string, MachineTriggers>>({});
	let errors = $state<Record<string, string | null>>({});
	let busy = $state<Record<string, boolean>>({});
	let selected = $state('');
	let open = $state<Record<string, boolean>>({});

	const machines = $derived(fleetStore.machines.filter((m) => m.server.id || m.local));
	$effect(() => {
		if (machines.length > 0 && !machines.some((m) => machineKey(m) === selected)) selected = machineKey(machines[0]);
	});
	const current = $derived(machines.find((m) => machineKey(m) === selected) ?? null);

	async function read(m: Machine) {
		const key = machineKey(m);
		const res = await fetch(`${apiBase(m)}/api/triggers`).catch(() => null);
		if (!res?.ok) {
			errors[key] = res?.status === 404 ? 'This machine runs a claude-mux without Triggers' : 'Did not answer';
			return;
		}
		errors[key] = null;
		data[key] = (await res.json()) as MachineTriggers;
	}

	async function send(m: Machine, path: string, method: string, body?: unknown): Promise<boolean> {
		const key = machineKey(m);
		busy[key] = true;
		try {
			const res = await fetch(`${apiBase(m)}/api/triggers${path}`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			}).catch(() => null);
			const answer = (await res?.json().catch(() => null)) as { error?: string } | null | undefined;
			if (!res?.ok) {
				errors[key] = answer?.error ?? 'Did not answer';
				return false;
			}
			errors[key] = null;
			await read(m);
			return true;
		} finally {
			busy[key] = false;
		}
	}

	const currentKey = $derived(current ? machineKey(current) : null);
	$effect(() => {
		if (!currentKey) return;
		const readCurrent = () => untrack(() => current && void read(current));
		readCurrent();
		const timer = setInterval(readCurrent, 5_000);
		return () => clearInterval(timer);
	});

	// ── the form ──────────────────────────────────────────────────────────────

	let showForm = $state(false);
	let name = $state('');
	let what = $state<TriggerAction>('session');
	let root = $state('');
	let prompt = $state('');
	let kind = $state<Schedule['type']>('every');
	let every = $state('1');
	let unit = $state<Unit>('hour');
	let days = $state<number[]>([1, 2, 3, 4, 5]);
	let time = $state('09:00');
	let onceAt = $state('');
	let limitMinutes = $state('45');
	let stopAtPr = $state(true);

	function schedule(): Schedule {
		if (kind === 'every') return { type: 'every', n: Number(every), unit };
		if (kind === 'weekly') return { type: 'weekly', days, time };
		return { type: 'once', at: new Date(onceAt).getTime() };
	}

	async function create(m: Machine) {
		// The server names the project's repo from its root.
		const ok = await send(m, '', 'POST', {
			name,
			what,
			root: what === 'session' ? root : null,
			prompt,
			when: schedule(),
			limitMinutes: Number(limitMinutes),
			stopAtPr
		});
		if (ok) {
			showForm = false;
			name = '';
			prompt = '';
		}
	}

	// ── reading a Trigger ─────────────────────────────────────────────────────

	const statusLabel = (s: RunStatus) => s.replace('-', ' ');

	function nextLine(t: TriggerView, now: number): string {
		if (t.kind === 'event') return 'When the next read of GitHub finds one';
		if (t.paused) return 'Paused';
		if (t.next === null) return 'Nothing left to fire';
		const ms = t.next - now;
		if (ms < 60_000) return `Next in ${Math.max(0, Math.round(ms / 1000))}s`;
		return `Next ${dateTime(t.next)}`;
	}

	/** A moment in the reader's own time zone. */
	function dateTime(at: number): string {
		return new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function linkHref(m: Machine, link: NonNullable<RunView['link']>): string {
		const host = m.local ? null : machineName(m);
		if (link.kind === 'session') return sessionPath({ host, target: link.href });
		if (link.kind === 'past') return pastPath(host, link.href);
		return link.href;
	}
</script>

<svelte:head><title>Triggers · claude-mux</title></svelte:head>

<div class="triggers">
	<header>
		<h1>Triggers</h1>
		<p class="lede">
			What fires on each machine, and when: a schedule or a GitHub event, running a rule or opening a session. A Trigger
			that opens a session never runs two at once, and starts only when the machine's worker limit and memory allow; any
			firing that does not happen is listed with why.
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
			{#if d.lastError}<p class="error" role="status">The scheduler's last tick failed: {d.lastError}</p>{/if}
			{#if !d.running}
				<p class="status">
					This server runs no scheduler, so nothing fires here (a dev server, unless started with CLAUDE_MUX_EVENTS=1).
				</p>
			{/if}

			<section>
				<div class="heading">
					<h2>On {machineName(current)}</h2>
					{#if d.running && !showForm}
						<Button size="sm" variant="secondary" onclick={() => (showForm = true)}>New Trigger</Button>
					{/if}
				</div>

				{#if showForm}
					<form
						class="form"
						onsubmit={(e) => {
							e.preventDefault();
							void create(current);
						}}
					>
						<label class="field">
							<span>Name</span>
							<Input bind:value={name} placeholder="Nightly link check" required maxlength={80} />
						</label>
						<div class="field">
							<span>Does</span>
							<span class="choices" role="radiogroup" aria-label="What it does">
								<Toggle size="sm" variant="outline" pressed={what === 'session'} onPressedChange={() => (what = 'session')}>
									Opens a session
								</Toggle>
								<Toggle size="sm" variant="outline" pressed={what === 'rule'} onPressedChange={() => (what = 'rule')}>
									Records a rule
								</Toggle>
							</span>
						</div>
						{#if what === 'session'}
							<div class="field">
								<span>Project</span>
								<span class="choices" role="radiogroup" aria-label="Project">
									{#each d.projects as p (p.root)}
										<Toggle size="sm" variant="outline" pressed={root === p.root} onPressedChange={() => (root = p.root)} title={p.root}
											>{p.repo}</Toggle
										>
									{:else}
										<span class="quiet">No project here has a GitHub remote.</span>
									{/each}
								</span>
							</div>
							<label class="field">
								<span>Prompt</span>
								<Textarea bind:value={prompt} rows={4} placeholder="What the session should do" required />
							</label>
						{/if}
						<div class="field">
							<span>When</span>
							<span class="choices" role="radiogroup" aria-label="When it fires">
								<Toggle size="sm" variant="outline" pressed={kind === 'every'} onPressedChange={() => (kind = 'every')}>Every</Toggle>
								<Toggle size="sm" variant="outline" pressed={kind === 'weekly'} onPressedChange={() => (kind = 'weekly')}>On weekdays</Toggle>
								<Toggle size="sm" variant="outline" pressed={kind === 'once'} onPressedChange={() => (kind = 'once')}>Once</Toggle>
							</span>
						</div>
						<div class="field when">
							<span></span>
							{#if kind === 'every'}
								<span class="inline">
									<Input type="number" min="1" bind:value={every} class="num" aria-label="How many" />
									<span class="choices" role="radiogroup" aria-label="Unit">
										{#each UNITS as u (u)}
											<Toggle size="sm" variant="outline" pressed={unit === u} onPressedChange={() => (unit = u)}>{u}s</Toggle>
										{/each}
									</span>
								</span>
							{:else if kind === 'weekly'}
								<span class="inline">
									{#each DAY_NAMES as day, i (day)}
										<Toggle
											size="sm"
											variant="outline"
											pressed={days.includes(i)}
											onPressedChange={(on) => (days = on ? [...days, i] : days.filter((x) => x !== i))}>{day}</Toggle
										>
									{/each}
									<Input type="time" bind:value={time} class="time" aria-label="Time" />
									<span class="quiet">{machineName(current)}'s time</span>
								</span>
							{:else}
								<Input type="datetime-local" bind:value={onceAt} required aria-label="Date and time" />
							{/if}
						</div>
						{#if what === 'session'}
							<div class="field">
								<span>Limit</span>
								<span class="inline">
									<Input type="number" min="1" bind:value={limitMinutes} class="num" aria-label="Time limit in minutes" />
									minutes
								</span>
							</div>
							<label class="field check">
								<span></span>
								<span class="inline">
									<Checkbox checked={stopAtPr} onCheckedChange={(v) => (stopAtPr = v === true)} />
									A bug it files stops at its pull request
								</span>
							</label>
						{/if}
						<div class="actions">
							<Button type="submit" size="sm" disabled={busy[key]}>Create</Button>
							<Button type="button" size="sm" variant="ghost" onclick={() => (showForm = false)}>Cancel</Button>
						</div>
					</form>
				{/if}

				{#if d.triggers.length === 0}
					<p class="quiet">
						No Triggers here yet. Create one above, or turn on a project's events on the <a href="/events">Events</a> screen.
					</p>
				{/if}
				<ul class="list">
					{#each d.triggers as t (t.id)}
						{@const last = t.runs[0]}
						<li class:paused={t.paused}>
							<div class="row1">
								<button class="name" onclick={() => (open[t.id] = !open[t.id])} aria-expanded={open[t.id] === true}>
									{t.name}
								</button>
								<span class="tag">{t.what === 'session' ? 'session' : 'rule'}</span>
								{#if t.kind === 'clock'}
									<Button
										size="sm"
										variant="ghost"
										disabled={busy[key]}
										onclick={() => void send(current, `/${encodeURIComponent(t.id)}`, 'PATCH', { paused: !t.paused })}
									>
										{t.paused ? 'Resume' : 'Pause'}
									</Button>
								{:else}
									<a class="set" href="/events">Set on Events</a>
								{/if}
							</div>
							<div class="sub">
								{t.when}{t.onceAt ? `, ${dateTime(t.onceAt)}` : ''}{t.repo ? ` · ${t.repo}` : ''} · {nextLine(t, clock.now)}
								{#if last}· last {statusLabel(last.status)} {formatAgo(last.at, clock.now)}{/if}
							</div>
							{#if open[t.id]}
								{#if t.prompt}<p class="prompt">{t.prompt}</p>{/if}
								{#if t.runs.length === 0}
									<p class="quiet runs-empty">No Runs yet.</p>
								{/if}
								<ul class="runs">
									{#each t.runs as r, i (`${r.at}-${i}`)}
										<li>
											<span class="status-tag {r.status}">{statusLabel(r.status)}</span>
											<span class="reason">{r.reason}{r.count ? ` · ${r.count} times in a row` : ''}</span>
											<span class="when">{formatAgo(r.at, clock.now)}</span>
											{#if r.link}
												<a class="link" href={linkHref(current, r.link)} target={r.link.kind === 'github' ? '_blank' : undefined}
													>{r.link.label}</a
												>
											{/if}
										</li>
									{/each}
								</ul>
								{#if t.kind === 'clock'}
									<div class="actions">
										<Button
											size="sm"
											variant="ghost"
											disabled={busy[key]}
											onclick={() => {
												if (confirm(`Delete “${t.name}” and its Runs?`)) void send(current, `/${encodeURIComponent(t.id)}`, 'DELETE');
											}}>Delete</Button
										>
									</div>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{:else}
			<p class="quiet">Reading…</p>
		{/if}
	{/if}
</div>

<style>
	.triggers {
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
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-muted);
	}
	.heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 24px 0 8px;
	}
	.lede {
		margin: 0 0 16px;
		max-width: 64ch;
		color: var(--ink-muted);
		line-height: 1.5;
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
	a {
		color: var(--ink);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.form {
		display: grid;
		gap: 10px;
		padding: 12px 0 16px;
		border-bottom: 1px solid var(--line);
	}
	.field {
		display: grid;
		grid-template-columns: 5.5em 1fr;
		align-items: center;
		gap: 10px;
	}
	.field > span:first-child {
		color: var(--ink-muted);
	}
	.choices,
	.inline {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
	}
	.inline :global(.num) {
		width: 5.5em;
	}
	.inline :global(.time) {
		width: 7.5em;
	}
	.actions {
		display: flex;
		gap: 6px;
		margin-top: 4px;
	}
	.list > li {
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
	}
	.row1 {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
		font-weight: 500;
		color: var(--ink);
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
	}
	.paused .name {
		color: var(--ink-muted);
	}
	.tag {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-dim);
	}
	.set {
		font-size: 12px;
		color: var(--ink-muted);
	}
	.sub {
		margin-top: 2px;
		color: var(--ink-dim);
		font-size: 12px;
	}
	.prompt {
		margin: 8px 0 0;
		white-space: pre-wrap;
		color: var(--ink-muted);
	}
	.runs-empty {
		margin: 8px 0 0;
	}
	.runs {
		margin-top: 6px;
	}
	.runs li {
		display: grid;
		grid-template-columns: 6.5em 1fr auto;
		gap: 2px 10px;
		padding: 5px 0;
		border-top: 1px solid var(--line);
	}
	.reason {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.when {
		color: var(--ink-dim);
		font-size: 12px;
	}
	.link {
		grid-column: 2 / -1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
	}
	.status-tag {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-dim);
	}
	.status-tag.ran,
	.status-tag.done,
	.status-tag.running {
		color: #34d399;
	}
	.status-tag.failed,
	.status-tag.timed-out {
		color: #f87171;
	}
</style>
