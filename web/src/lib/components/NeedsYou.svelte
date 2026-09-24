<script lang="ts">
	/**
	 * Everything across the fleet that is waiting on a person, oldest first.
	 *
	 * A dialog open in a pane is only one way an agent waits. A maestro worker
	 * that labels its issue `needs-help` has stopped and gone quiet — its pane
	 * reads idle — and a wayfinder ticket that only a conversation resolves
	 * waits on GitHub with no session at all. The project cards scatter the
	 * first kind and cannot show the other two, so this card gathers them in
	 * the order they started waiting: the longest wait is the one at the top.
	 */
	import { onMount } from 'svelte';
	import type { Machine } from '$lib/stores/fleet.svelte';
	import { getSessionDisplayName, needsHelp, type Session } from '$lib/stores/sessions.svelte';
	import type { InboxTicket } from '$shared/types/ws-messages.js';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';

	interface Props {
		machines: Machine[];
		onOpen: (machine: Machine, tmuxTarget: string) => void;
		/** Start a Claude session in the ticket's repo, working that ticket. */
		onStart: (machine: Machine, ticket: InboxTicket) => void;
	}

	let { machines, onOpen, onStart }: Props = $props();

	type Waiting =
		| { kind: 'session'; key: string; machine: Machine; session: Session; since: number }
		| { kind: 'help'; key: string; machine: Machine; ticket: InboxTicket; session: Session | null; since: number };

	interface Ready {
		key: string;
		machine: Machine;
		ticket: InboxTicket;
	}

	const waiting = $derived.by(() => {
		const out: Waiting[] = [];
		for (const machine of machines) {
			const host = machine.server.hostname;
			for (const s of machine.sessions) {
				if (s.pane_alive === false) continue;
				if (s.state !== 'waiting' && s.state !== 'permission') continue;
				out.push({ kind: 'session', key: `${host}/s/${s.id}`, machine, session: s, since: s.last_update });
			}
			for (const t of machine.inbox) {
				if (t.kind !== 'needs-help') continue;
				const session =
					machine.sessions.find(
						(s) => s.pane_alive !== false && s.maestro_issue === t.number && s.git_root === t.git_root
					) ?? null;
				// The worker's own row already says it waits when a dialog is open.
				if (session && (session.state === 'waiting' || session.state === 'permission')) continue;
				out.push({ kind: 'help', key: `${host}/h/${t.repo}#${t.number}`, machine, ticket: t, session, since: t.since });
			}
		}
		return out.sort((a, b) => a.since - b.since);
	});

	const ready = $derived.by(() => {
		const out: Ready[] = [];
		for (const machine of machines) {
			for (const t of machine.inbox) {
				if (t.kind === 'needs-help') continue;
				out.push({ key: `${machine.server.hostname}/t/${t.repo}#${t.number}`, machine, ticket: t });
			}
		}
		return out.sort((a, b) => a.ticket.since - b.ticket.since);
	});

	/** Tickets past this many fold behind a count; the waiting list never folds. */
	const READY_SHOWN = 3;
	let showAllReady = $state(false);
	const readyShown = $derived(showAllReady ? ready : ready.slice(0, READY_SHOWN));

	const multiHost = $derived(machines.length > 1);

	let now = $state(Date.now());
	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(tick);
	});

	function waited(ts: number): string {
		const s = Math.max(0, Math.round((now - ts) / 1000));
		if (s < 60) return 'now';
		if (s < 3600) return `${Math.round(s / 60)}m`;
		if (s < 86400) return `${Math.round(s / 3600)}h`;
		return `${Math.round(s / 86400)}d`;
	}

	/** What the session is asking, in the fewest words the poll has. */
	function asking(s: Session): string {
		if (s.state === 'waiting') return s.pane_choice?.question || s.current_action || 'Asking you a question';
		return s.current_action || 'Asking permission to go on';
	}

	function repoName(t: InboxTicket): string {
		return t.repo.split('/').pop() ?? t.repo;
	}

	function openHelp(item: Extract<Waiting, { kind: 'help' }>) {
		if (item.session?.tmux_target) onOpen(item.machine, item.session.tmux_target);
		else window.open(item.ticket.url, '_blank', 'noopener');
	}

	const KIND_ICON: Record<InboxTicket['kind'], string> = {
		'needs-help': 'mdi:hand-back-right-outline',
		grilling: 'mdi:signpost-outline',
		prototype: 'mdi:shape-outline'
	};
</script>

{#if waiting.length > 0 || ready.length > 0}
	<section class="needs" class:urgent={waiting.length > 0} aria-label="Needs you">
		<header class="h">
			<span class="t">Needs you</span>
			<span class="line"></span>
			{#if waiting.length > 0}<span class="n">{waiting.length}</span>{/if}
		</header>

		{#each waiting as item (item.key)}
			{#if item.kind === 'session'}
				{@const s = item.session}
				<button
					type="button"
					class="it"
					onclick={() => s.tmux_target && onOpen(item.machine, s.tmux_target)}
					title={s.cwd}
				>
					<span class="ic"><SessionStateIndicator state={s.state} size="sm" /></span>
					<span class="name">{getSessionDisplayName(s)}</span>
					<span class="when">{waited(item.since)}</span>
					<span class="sub">
						{asking(s)}{#if multiHost}<span class="host">{item.machine.server.hostname}</span>{/if}
					</span>
				</button>
			{:else}
				{@const t = item.ticket}
				<button type="button" class="it" onclick={() => openHelp(item)} title={t.url}>
					<span class="ic help"><iconify-icon icon={KIND_ICON['needs-help']}></iconify-icon></span>
					<span class="name">{item.session && needsHelp(item.session) ? getSessionDisplayName(item.session) : t.title}</span>
					<span class="when">{waited(item.since)}</span>
					<span class="sub note">
						<span class="num">#{t.number}</span>{t.note ?? 'Worker asked for a decision'}
					</span>
				</button>
			{/if}
		{/each}

		{#if ready.length > 0}
			<div class="ready-h" class:first={waiting.length === 0}>
				Ready to decide
				{#if ready.length > READY_SHOWN}
					<button type="button" class="more" onclick={() => (showAllReady = !showAllReady)}>
						{showAllReady ? 'fewer' : `all ${ready.length}`}
					</button>
				{/if}
			</div>
			{#each readyShown as item (item.key)}
				{@const t = item.ticket}
				<div class="it ticket">
					<span class="ic"><iconify-icon icon={KIND_ICON[t.kind]}></iconify-icon></span>
					<a class="name" href={t.url} target="_blank" rel="noopener" title="Open on GitHub">{t.title}</a>
					<button
						type="button"
						class="start"
						title="Open a Claude session in {repoName(t)} that works this ticket with you"
						onclick={() => onStart(item.machine, t)}
					>
						Start
					</button>
					<span class="sub">
						<span class="num">#{t.number}</span>{t.kind} in {repoName(t)}{#if multiHost}<span class="host"
								>{item.machine.server.hostname}</span
							>{/if}
					</span>
				</div>
			{/each}
		{/if}
	</section>
{/if}

<style>
	/* The sidebar's own surface and ink, so the card sits among the project
	   cards as one of them. Amber marks only what holds an agent up. */
	.needs {
		--surface: #151516;
		--surface-2: #1b1b1d;
		--surface-3: #212124;
		--line: #2a2a2c;
		--text: #e7e5e4;
		--muted: #a8a29e;
		--dim: #6b6764;
		--amber: #f59e0b;
		--amber-soft: #3a2d0d;
		display: flex;
		flex-direction: column;
		padding: 5px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 14px;
		font-size: 13px;
		color: var(--text);
	}
	.needs.urgent {
		border-color: #5a4310;
		box-shadow: inset 0 0 0 1px var(--amber-soft);
	}

	.h {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px 4px 7px;
	}
	.t {
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.urgent .t {
		color: var(--amber);
	}
	.line {
		flex: 1;
		height: 1px;
		background: var(--line);
	}
	.n {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--amber);
	}

	/* One waiting thing: the session row's grid, so the eye reads both alike. */
	.it {
		display: grid;
		grid-template-columns: 16px 1fr auto;
		column-gap: 8px;
		align-items: center;
		width: 100%;
		padding: 6px 7px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.it:hover {
		background: var(--surface-2);
	}
	.it:focus-visible,
	.start:focus-visible,
	.more:focus-visible,
	a.name:focus-visible {
		outline: 2px solid var(--amber);
		outline-offset: 1px;
	}
	.ic {
		display: grid;
		place-items: center;
		width: 16px;
		font-size: 14px;
		color: var(--dim);
	}
	.ic.help {
		color: var(--amber);
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: var(--text);
		text-decoration: none;
	}
	a.name:hover {
		text-decoration: underline dotted;
	}
	.when {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--amber);
		white-space: nowrap;
	}
	.sub {
		grid-column: 2 / 4;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
		margin-top: 1px;
	}
	.sub.note {
		color: var(--muted);
	}
	.num {
		color: var(--muted);
		margin-right: 6px;
	}
	.host {
		margin-left: 6px;
		padding: 0 5px;
		border-radius: 4px;
		background: var(--surface-3);
		font-size: 10px;
	}

	/* Tickets nobody is blocked on yet: quieter, and each can start its own
	   session. */
	.ready-h {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 6px 7px 2px;
		padding-top: 7px;
		border-top: 1px solid var(--line);
		font-size: 11.5px;
		color: var(--dim);
	}
	.ready-h.first {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
	}
	.more {
		margin-left: auto;
		border: 0;
		background: none;
		padding: 0;
		color: var(--muted);
		font: inherit;
		text-decoration: underline dotted;
		cursor: pointer;
	}
	.it.ticket {
		cursor: default;
	}
	.start {
		height: 22px;
		padding: 0 9px;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--surface-3);
		color: var(--text);
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.start:hover {
		border-color: #3f3f46;
		background: #2a2a2e;
	}
	@media (pointer: coarse) {
		.it {
			padding-top: 9px;
			padding-bottom: 9px;
		}
		.start {
			height: 32px;
			padding: 0 12px;
		}
	}
</style>
