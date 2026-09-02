<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		sessionStore,
		getProjectColor,
		groupSessions,
		getSessionDisplayName,
		findDeepestProject,
		type Session
	} from '$lib/stores/sessions.svelte';
	import { fleetStore, type Machine } from '$lib/stores/fleet.svelte';
	import { serverStore } from '$lib/stores/servers.svelte';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';
	import { tmuxPanesStore } from '$lib/stores/tmuxPanes.svelte';
	import { draftsStore } from '$lib/stores/drafts.svelte';
	import { AGENTS, AGENT_IDS } from '$shared/agents.js';
	import type { SessionAgent } from '$shared/db/index.js';
	import type { TmuxPane } from '$lib/types/tmux';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { longPress } from '$lib/actions/longPress';
	import ServerPicker from './ServerPicker.svelte';
	import RenameSessionDialog from './RenameSessionDialog.svelte';
	import FolderPicker from './FolderPicker.svelte';
	import { STORAGE_KEYS } from '$lib/constants';
	import { sidebarActionsStore, type ChordAction } from '$lib/stores/sidebarActions.svelte';

	interface Props {
		onSessionSelect?: () => void;
		compact?: boolean;
	}

	let { onSessionSelect, compact = false }: Props = $props();

	// ── dialogs ────────────────────────────────────────────────────────────
	let showFolderBrowser = $state(false);
	let folderPicker = $state<FolderPicker | null>(null);
	let alertOpen = $state(false);
	let alertTitle = $state('');
	let alertMessage = $state('');
	let alertOnConfirm = $state<() => void>(() => {});
	let renameId = $state<string | null>(null);
	let menuOpen = $state(false);
	let searchOpen = $state(false);
	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);

	function showConfirm(title: string, message: string, onConfirm: () => void) {
		alertTitle = title;
		alertMessage = message;
		alertOnConfirm = onConfirm;
		alertOpen = true;
	}

	/** Which machine a new session should be made on, and where. */
	let agentPicker = $state<{ machine: Machine; cwd: string } | null>(null);

	function pickAgent(agent: SessionAgent) {
		const target = agentPicker;
		agentPicker = null;
		if (target) void newSessionInProject(target.machine, target.cwd, agent);
	}

	// ── the model: one view per machine ─────────────────────────────────────

	/** A live session in a project card, with where it sits under the root. */
	interface Row {
		session: Session;
		/** `web/` when the session runs below the project root; null at the root. */
		rel: string | null;
		orchestrator: boolean;
	}

	interface Card {
		cwd: string;
		name: string;
		color: string;
		/** A session in it is asking for a person. */
		wants: boolean;
		rows: Row[];
		dead: Session[];
		panes: TmuxPane[];
		/** Newest activity, for ordering. */
		recent: number;
	}

	interface MachineView {
		machine: Machine;
		cards: Card[];
		/** Roots with nothing running: shown as chips. */
		quiet: Card[];
		loose: Row[];
		loosePanes: TmuxPane[];
	}

	const tmuxPanes = $derived(tmuxPanesStore.panes);
	const tmuxPanesLoaded = $derived(tmuxPanesStore.loaded);

	const currentTarget = $derived(
		$page.url.pathname.startsWith('/session/')
			? decodeURIComponent($page.url.pathname.split('/session/')[1])
			: null
	);

	/**
	 * Whether a directory is nobody's project. The server knows the home
	 * directory and keeps such paths out of the list it sends; this is the
	 * browser's guess for a session whose cwd is not under any root — a path
	 * two segments deep (`/home/leo`, `/tmp`) or a mount point.
	 */
	function looksLikeRoot(cwd: string): boolean {
		const parts = cwd.split('/').filter(Boolean);
		if (parts.length <= 2) return true;
		return /^\/(?:mnt|media|Volumes)\/[^/]+$/.test(cwd);
	}

	function under(child: string, parent: string): boolean {
		return child === parent || child.startsWith(parent + '/');
	}

	/**
	 * The project roots of a machine: what the server remembers, plus any
	 * session directory under none of them (an older server, or a session
	 * that started this tick), reduced so no root sits under another.
	 */
	function rootsOf(machine: Machine): string[] {
		const roots = [...machine.projects];
		const extra = machine.sessions
			.map((s) => s.cwd)
			.filter((cwd): cwd is string => !!cwd && !looksLikeRoot(cwd))
			.sort((a, b) => a.length - b.length);
		for (const cwd of extra) {
			if (roots.some((r) => under(cwd, r))) continue;
			roots.push(cwd);
		}
		return roots;
	}

	function relPath(cwd: string, root: string): string | null {
		return cwd === root ? null : cwd.slice(root.length + 1) + '/';
	}

	function wantsHuman(s: Session): boolean {
		return s.state === 'waiting' || s.state === 'permission';
	}

	function rowsFor(sessions: Session[], root: string | null): Row[] {
		const rows: Row[] = [];
		for (const item of groupSessions(sessions)) {
			if (item.type === 'pair') {
				rows.push({ session: item.main, rel: root ? relPath(item.main.cwd, root) : null, orchestrator: false });
				rows.push({ session: item.orchestrator, rel: null, orchestrator: true });
			} else {
				rows.push({ session: item.session, rel: root ? relPath(item.session.cwd, root) : null, orchestrator: false });
			}
		}
		return rows;
	}

	function matches(text: string): boolean {
		const q = query.trim().toLowerCase();
		return !q || text.toLowerCase().includes(q);
	}

	function viewOf(machine: Machine): MachineView {
		const roots = rootsOf(machine);
		const claudeTargets = new Set(machine.sessions.map((s) => s.tmux_target));
		// tmux panes are read from this host only.
		const panes = machine.local ? tmuxPanes.filter((p) => !claudeTargets.has(p.target)) : [];

		const byRoot = new Map<string, { live: Session[]; dead: Session[]; panes: TmuxPane[] }>();
		for (const root of roots) byRoot.set(root, { live: [], dead: [], panes: [] });
		const loose: Session[] = [];
		for (const s of machine.sessions) {
			const root = s.cwd ? findDeepestProject(s.cwd, roots) : null;
			if (!root) {
				loose.push(s);
				continue;
			}
			const bucket = byRoot.get(root)!;
			(s.pane_alive === false ? bucket.dead : bucket.live).push(s);
		}
		const loosePanes: TmuxPane[] = [];
		for (const pane of panes) {
			const root = pane.cwd ? findDeepestProject(pane.cwd, roots) : null;
			if (root) byRoot.get(root)!.panes.push(pane);
			else loosePanes.push(pane);
		}

		const cards: Card[] = [];
		const quiet: Card[] = [];
		for (const root of roots) {
			const bucket = byRoot.get(root)!;
			const name = root.split('/').pop() || root;
			const rows = rowsFor(bucket.live, root);
			const card: Card = {
				cwd: root,
				name,
				color: getProjectColor(root),
				wants: bucket.live.some(wantsHuman),
				rows,
				dead: bucket.dead,
				panes: bucket.panes,
				recent: Math.max(0, ...bucket.live.map((s) => s.last_update ?? 0))
			};
			if (query.trim()) {
				const hit = matches(name) || rows.some((r) => matches(getSessionDisplayName(r.session)));
				if (!hit) continue;
			}
			// Nothing running — closed sessions included — is a chip, not a card.
			if (rows.length === 0 && bucket.panes.length === 0) quiet.push(card);
			else cards.push(card);
		}
		// Whoever wants a person first, then by activity, then by name.
		cards.sort((a, b) => {
			if (a.wants !== b.wants) return a.wants ? -1 : 1;
			if (a.recent !== b.recent) return b.recent - a.recent;
			return a.name.localeCompare(b.name);
		});
		quiet.sort((a, b) => a.name.localeCompare(b.name));

		return {
			machine,
			cards,
			quiet,
			loose: rowsFor(loose.filter((s) => matches(getSessionDisplayName(s))), null),
			loosePanes: query.trim() ? loosePanes.filter((p) => matches(p.target)) : loosePanes
		};
	}

	const views = $derived(fleetStore.visible.map(viewOf));
	const anything = $derived(
		views.some((v) => v.cards.length + v.quiet.length + v.loose.length + v.loosePanes.length > 0)
	);

	/** Live sessions per machine, for the strip. */
	function liveCount(machine: Machine): number {
		return machine.sessions.filter((s) => s.pane_alive !== false).length;
	}

	function machineWants(machine: Machine): boolean {
		return machine.sessions.some((s) => s.pane_alive !== false && wantsHuman(s));
	}

	// ── time, labels ─────────────────────────────────────────────────────────
	let now = $state(Date.now());
	onMount(() => {
		fleetStore.start();
		const tick = setInterval(() => (now = Date.now()), 30_000);
		const unsubscribe = tmuxPanesStore.subscribe();
		return () => {
			clearInterval(tick);
			unsubscribe?.();
		};
	});

	$effect(() => {
		fleetStore.sync();
	});

	$effect(() => {
		if (searchOpen) searchInput?.focus();
	});

	function ago(ts: number | undefined): string {
		if (!ts) return '';
		const s = Math.max(0, Math.round((now - ts) / 1000));
		if (s < 60) return 'now';
		if (s < 3600) return `${Math.round(s / 60)}m`;
		if (s < 86400) return `${Math.round(s / 3600)}h`;
		return `${Math.round(s / 86400)}d`;
	}

	function detectPaneAgent(command: string): SessionAgent | null {
		const cmd = command.toLowerCase();
		for (const id of AGENT_IDS) if (cmd.includes(id)) return id;
		return null;
	}

	// ── actions ──────────────────────────────────────────────────────────────

	/** Where a machine's API lives: this origin for the local one, its URL otherwise. */
	function apiBase(machine: Machine): string {
		return machine.local ? '' : machine.server.url;
	}

	function openSession(machine: Machine, tmuxTarget: string) {
		if (machine.local) {
			goto(`/session/${encodeURIComponent(tmuxTarget)}`);
			onSessionSelect?.();
		} else {
			// The terminal and composer talk to the session's own host.
			window.location.href = `${machine.server.url}/session/${encodeURIComponent(tmuxTarget)}`;
		}
	}

	function handleRowClick(e: MouseEvent, machine: Machine, session: Session) {
		e.preventDefault();
		if (e.detail >= 2 && machine.local) {
			renameId = session.id;
			return;
		}
		if (session.tmux_target) openSession(machine, session.tmux_target);
	}

	function killSessionReq(machine: Machine, s: Session) {
		return fetch(`${apiBase(machine)}/api/sessions/${encodeURIComponent(s.id)}/kill`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pid: s.pid, tmux_target: s.tmux_target })
		});
	}

	function killSession(machine: Machine, s: Session) {
		showConfirm('Kill session', `Kill “${getSessionDisplayName(s)}”?`, () => {
			void killSessionReq(machine, s);
		});
	}

	function sweepDead(machine: Machine, dead: Session[]) {
		for (const s of dead) void killSessionReq(machine, s);
	}

	function closeProject(machine: Machine, card: Card) {
		const live = card.rows.filter((r) => !r.orchestrator).map((r) => r.session);
		const msg =
			live.length > 0
				? `Kill ${live.length} session${live.length === 1 ? '' : 's'} in ${card.name} and remove the project?`
				: `Remove ${card.name} from the list? Its sessions are gone; the folder stays.`;
		showConfirm('Close project', msg, async () => {
			await Promise.all([...live, ...card.dead].map((s) => killSessionReq(machine, s)));
			if (machine.local) sessionStore.removeProject(card.cwd);
			else
				void fetch(`${machine.server.url}/api/projects`, {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ cwd: card.cwd })
				});
		});
	}

	async function newSessionInProject(machine: Machine, cwd: string, agent: SessionAgent = 'claude') {
		const res = await fetch(`${apiBase(machine)}/api/projects/new-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd, agent })
		});
		const data = await res.json();
		if (!data.ok) {
			alert(`Failed to create session: ${data.detail || data.error || 'Unknown error'}`);
			return;
		}
		if (machine.local) {
			sessionStore.saveProject(cwd);
			if (data.record) sessionStore.optimisticAdd(data.record);
		}
		const tmuxTarget = data.tmuxTarget || data.session + ':0.0';
		openSession(machine, tmuxTarget);
	}

	/** The machine “Nova” acts on: the one filtered to, or this one. */
	const actingMachine = $derived(
		fleetStore.visible.length === 1 ? fleetStore.visible[0] : fleetStore.machines[0]
	);

	function newProject() {
		if (actingMachine.local) void folderPicker?.openAt();
		// Browsing another machine's disk happens on that machine.
		else window.location.href = `${actingMachine.server.url}/`;
	}

	async function closeChrome() {
		await fetch('/api/chrome', { method: 'DELETE' });
	}

	const RESET_KEEP_KEYS = new Set<string>([STORAGE_KEYS.lastSession]);

	function resetLocalStorage() {
		showConfirm(
			'Reset local data',
			'This clears preferences and cached data in this browser. Your projects stay on the server. The page will reload.',
			() => {
				for (let i = localStorage.length - 1; i >= 0; i--) {
					const key = localStorage.key(i);
					if (key && key.startsWith('claude-mux-') && !RESET_KEEP_KEYS.has(key)) {
						localStorage.removeItem(key);
					}
				}
				window.location.reload();
			}
		);
	}

	/** The rare actions, behind the menu; the same list feeds the chord menu. */
	const menuActions: ChordAction[] = $derived([
		{ label: 'Usage', icon: 'mdi:chart-line', run: () => void goto('/usage') },
		{ label: 'Close Chrome', icon: 'mdi:google-chrome', run: () => void closeChrome() },
		{ label: 'Refresh', icon: 'mdi:refresh', run: () => location.reload() },
		{
			label: sessionStore.paused ? 'Resume updates' : 'Pause updates',
			icon: sessionStore.paused ? 'mdi:play' : 'mdi:pause',
			run: () => sessionStore.togglePause(),
			variant: sessionStore.paused ? 'destructive' : 'secondary'
		},
		{ label: 'Reset data', icon: 'mdi:database-refresh', run: () => resetLocalStorage(), danger: true }
	]);

	$effect(() => {
		sidebarActionsStore.set([
			...menuActions,
			{ label: 'New project', icon: 'mdi:plus', run: () => newProject() }
		]);
	});
</script>

{#snippet ring(pct: number | null | undefined)}
	{#if pct !== null && pct !== undefined}
		<span
			class="ctx"
			class:warn={pct >= 70 && pct < 90}
			class:hot={pct >= 90}
			style="--p: {Math.min(100, Math.max(0, pct))}"
			title="{pct}% of the context window"
		></span>
	{:else}
		<span class="ctx none"></span>
	{/if}
{/snippet}

{#snippet sessionRow(machine: Machine, row: Row)}
	{@const s = row.session}
	{@const isActive = machine.local && s.tmux_target === currentTarget}
	{@const draft = machine.local && !isActive && s.tmux_target ? draftsStore.get(s.tmux_target) : ''}
	{@const wants = wantsHuman(s)}
	<a
		href={machine.local && s.tmux_target ? `/session/${encodeURIComponent(s.tmux_target)}` : `${machine.server.url}/session/${encodeURIComponent(s.tmux_target ?? '')}`}
		class="row"
		class:cur={isActive}
		class:orch={row.orchestrator}
		onclick={(e) => handleRowClick(e, machine, s)}
		use:longPress={{ onTrigger: () => { if (machine.local) renameId = s.id; } }}
		title={machine.local ? 'Double-click or long-press to rename' : `On ${machine.server.hostname}`}
	>
		<span class="st"><SessionStateIndicator state={s.state} size="sm" title={s.current_action} /></span>
		<span class="name">
			{#if row.orchestrator}<span class="path">orch</span>{:else if row.rel}<span class="path" title={s.cwd}>{row.rel}</span>{/if}
			{getSessionDisplayName(s)}
		</span>
		<span class="meta">
			{#if s.rc_url}
				<iconify-icon icon="mdi:cellphone-link" class="rc" title="Remote Control active"></iconify-icon>
			{/if}
			{#if wants}
				<span class="pill">wants you</span>
			{:else}
				<span class="when">{ago(s.last_update)}</span>
			{/if}
		</span>
		{@render ring(s.context_pct)}
		{#if machine.local && !compact}
			<button
				type="button"
				class="kill"
				title="Kill session"
				onclick={(e) => { e.preventDefault(); e.stopPropagation(); killSession(machine, s); }}
			>
				<iconify-icon icon="mdi:power"></iconify-icon>
			</button>
		{/if}
		<span class="sub" class:draft={!!draft} title={draft || s.current_action || s.state}>
			{#if draft}
				<iconify-icon icon="mdi:pencil-outline"></iconify-icon>{draftsStore.preview(s.tmux_target!)}
			{:else}
				{s.current_action || s.state}
			{/if}
		</span>
	</a>
{/snippet}

{#snippet paneRow(machine: Machine, pane: TmuxPane)}
	{@const isActive = pane.target === currentTarget}
	{@const detected = detectPaneAgent(pane.command || '')}
	{@const meta = detected ? AGENTS[detected] : null}
	<a
		href="/session/{encodeURIComponent(pane.target)}"
		class="row tmux"
		class:cur={isActive}
		onclick={(e) => { e.preventDefault(); openSession(machine, pane.target); }}
	>
		<span class="st">
			<iconify-icon icon={meta?.icon ?? 'mdi:console-line'} style={meta ? `color:${meta.color}` : ''}></iconify-icon>
		</span>
		<span class="name mono">{pane.target}</span>
		<span class="meta"><span class="when">{meta?.label ?? pane.command}</span></span>
		<span class="ctx none"></span>
	</a>
{/snippet}

{#snippet projectCard(machine: Machine, card: Card)}
	<section class="card proj" class:wants={card.wants}>
		<div class="proj-h">
			<span class="chip" style="background:{card.color}">{card.name.slice(0, 1).toLowerCase()}</span>
			<span class="pname" title={card.cwd}>{card.name}</span>
			<span class="pcount">{card.rows.filter((r) => !r.orchestrator).length}</span>
			<button
				type="button"
				class="pbtn"
				title="New session here (right-click or hold for another agent)"
				onclick={() => void newSessionInProject(machine, card.cwd)}
				oncontextmenu={(e) => { e.preventDefault(); agentPicker = { machine, cwd: card.cwd }; }}
				use:longPress={{ onTrigger: () => (agentPicker = { machine, cwd: card.cwd }) }}
			>
				<iconify-icon icon="mdi:plus"></iconify-icon>
			</button>
			<button type="button" class="pbtn pclose" title="Close project" onclick={() => closeProject(machine, card)}>
				<iconify-icon icon="mdi:close"></iconify-icon>
			</button>
		</div>
		{#each card.rows as row (row.session.id)}
			{@render sessionRow(machine, row)}
		{/each}
		{#each card.panes as pane (pane.target)}
			{@render paneRow(machine, pane)}
		{/each}
		{#if card.dead.length > 0}
			<div class="dead">
				<span class="n">{card.dead.length}</span>
				{card.dead.length === 1 ? 'closed session' : 'closed sessions'}
				{#if machine.local}
					<button type="button" class="sweep" onclick={() => sweepDead(machine, card.dead)}>clear</button>
				{/if}
			</div>
		{/if}
	</section>
{/snippet}

<div class="panel" class:compact>
	<header class="card head">
		<ServerPicker />
		<button type="button" class="ghost" class:lit={searchOpen} title="Find a session" onclick={() => { searchOpen = !searchOpen; if (!searchOpen) query = ''; }}>
			<iconify-icon icon="mdi:magnify"></iconify-icon>
		</button>
		<Popover.Root bind:open={menuOpen}>
			<Popover.Trigger class="ghost" title="More">
				<iconify-icon icon="mdi:dots-horizontal"></iconify-icon>
			</Popover.Trigger>
			<Popover.Content class="menu" align="end" sideOffset={6}>
				{#each menuActions as action (action.label)}
					<button type="button" class="mitem" class:danger={action.danger} onclick={() => { menuOpen = false; action.run(); }}>
						<iconify-icon icon={action.icon}></iconify-icon>{action.label}
					</button>
				{/each}
			</Popover.Content>
		</Popover.Root>
		<button type="button" class="new" title="New project or session" onclick={newProject}>
			<iconify-icon icon="mdi:plus"></iconify-icon>New
		</button>
	</header>

	{#if searchOpen}
		<input
			bind:this={searchInput}
			bind:value={query}
			class="search"
			type="search"
			placeholder="Project or session…"
			onkeydown={(e) => { if (e.key === 'Escape') { searchOpen = false; query = ''; } }}
		/>
	{/if}

	{#if fleetStore.fleet}
		<div class="machines" role="tablist" aria-label="Machines">
			<button type="button" class="m" class:on={fleetStore.selected === 'all'} role="tab" onclick={() => fleetStore.select('all')}>all</button>
			{#each fleetStore.machines as machine (machine.server.hostname)}
				<button
					type="button"
					class="m"
					class:on={fleetStore.selected === machine.server.hostname}
					class:wants={machineWants(machine)}
					role="tab"
					title={machine.connected ? machine.server.url : `${machine.server.hostname} is unreachable`}
					onclick={() => fleetStore.select(machine.server.hostname)}
				>
					<span class="dot" class:off={!machine.connected}></span>
					{machine.server.hostname || 'this machine'}
					{#if liveCount(machine) > 0}<span class="n">{liveCount(machine)}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}

	<div class="list">
		{#if !anything}
			<div class="empty">
				{#if query.trim()}
					Nothing matches “{query}”.
				{:else}
					No sessions yet. <button type="button" class="link" onclick={newProject}>Open a project</button> to start one.
				{/if}
			</div>
		{/if}
		{#each views as view (view.machine.server.hostname)}
			{#if fleetStore.fleet && fleetStore.selected === 'all'}
				<div class="mlabel">
					<span class="dot" class:off={!view.machine.connected}></span>
					{view.machine.server.hostname || 'this machine'}
				</div>
			{/if}
			{#each view.cards as card (card.cwd)}
				{@render projectCard(view.machine, card)}
			{/each}
			{#if view.quiet.length > 0}
				{@const closed = view.quiet.flatMap((c) => c.dead)}
				<section class="card quiet">
					<span class="lbl">
						no session
						{#if closed.length > 0 && view.machine.local}
							<button type="button" class="sweep" title="Forget the closed sessions in these projects" onclick={() => sweepDead(view.machine, closed)}>
								clear {closed.length} closed
							</button>
						{/if}
					</span>
					{#each view.quiet as card (card.cwd)}
						<span class="q" title={card.cwd}>
							<button
								type="button"
								class="qopen"
								onclick={() => void newSessionInProject(view.machine, card.cwd)}
								oncontextmenu={(e) => { e.preventDefault(); agentPicker = { machine: view.machine, cwd: card.cwd }; }}
								use:longPress={{ onTrigger: () => (agentPicker = { machine: view.machine, cwd: card.cwd }) }}
							>
								<span class="chip" style="background:{card.color}"></span>{card.name}
								{#if card.dead.length > 0}<span class="qdead" title="{card.dead.length} closed session{card.dead.length === 1 ? '' : 's'}">·{card.dead.length}</span>{/if}
							</button>
							<button type="button" class="qx" title="Remove from the list" onclick={() => closeProject(view.machine, card)}>
								<iconify-icon icon="mdi:close"></iconify-icon>
							</button>
						</span>
					{/each}
				</section>
			{/if}
			{#if view.loose.length > 0 || (tmuxPanesLoaded && view.loosePanes.length > 0)}
				<section class="card proj loose">
					<div class="proj-h">
						<span class="chip dim">~</span>
						<span class="pname">outside any project</span>
						<span class="pcount">{view.loose.filter((r) => !r.orchestrator).length + view.loosePanes.length}</span>
					</div>
					{#each view.loose as row (row.session.id)}
						{@render sessionRow(view.machine, row)}
					{/each}
					{#each view.loosePanes as pane (pane.target)}
						{@render paneRow(view.machine, pane)}
					{/each}
				</section>
			{/if}
		{/each}
	</div>
</div>

<FolderPicker
	bind:this={folderPicker}
	bind:open={showFolderBrowser}
	onpick={(cwd) => void newSessionInProject(fleetStore.machines[0], cwd)}
/>

<Dialog.Root open={agentPicker !== null} onOpenChange={(o) => { if (!o) agentPicker = null; }}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>New session</Dialog.Title>
			<Dialog.Description>
				{#if agentPicker}In {agentPicker.cwd}{#if !agentPicker.machine.local} on {agentPicker.machine.server.hostname}{/if}.{/if}
				Choose which agent to launch.
			</Dialog.Description>
		</Dialog.Header>
		<div class="agent-choices">
			{#each AGENT_IDS as id (id)}
				{@const meta = AGENTS[id]}
				<button class="agent-choice" onclick={() => pickAgent(id)}>
					<iconify-icon icon={meta.icon} style="color: {meta.color};"></iconify-icon>
					<div class="agent-choice-text">
						<div class="agent-choice-name">{meta.label}</div>
						<div class="agent-choice-cmd">{meta.command}</div>
					</div>
				</button>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>

<RenameSessionDialog sessionId={renameId} onClose={() => (renameId = null)} />

<AlertDialog.Root bind:open={alertOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{alertTitle}</AlertDialog.Title>
			<AlertDialog.Description>{alertMessage}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => { alertOnConfirm(); alertOpen = false; }} class="bg-destructive text-destructive-foreground hover:bg-destructive/90">Confirm</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	/* The composer's surface, borrowed: one panel, cards on it. */
	.panel {
		--surface: #151516;
		--surface-2: #1b1b1d;
		--surface-3: #212124;
		--line: #2a2a2c;
		--line-soft: #1f1f21;
		--text: #e7e5e4;
		--muted: #a8a29e;
		--dim: #6b6764;
		--faint: #3a3836;
		--amber: #f59e0b;
		--amber-soft: #3a2d0d;
		--green: #34d399;
		--green-deep: #15803d;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 10px 4px;
		font-size: 13px;
		color: var(--text);
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 14px;
	}

	/* ── header ─────────────────────────────────────────────── */
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 7px 7px 8px;
	}
	.head :global(.server-picker-trigger) {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		padding: 4px 6px;
	}
	.head :global(.server-picker-trigger:hover) {
		background: var(--surface-3);
	}
	.head :global(.server-picker-trigger .hostname) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.panel :global(.ghost) {
		width: 30px;
		height: 30px;
		flex: none;
		display: inline-grid;
		place-items: center;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--muted);
		font-size: 17px;
		cursor: pointer;
	}
	.panel :global(.ghost:hover),
	.panel :global(.ghost.lit) {
		background: var(--surface-3);
		color: var(--text);
	}
	.new {
		height: 30px;
		flex: none;
		padding: 0 11px 0 8px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 0;
		border-radius: 9px;
		background: var(--green-deep);
		color: #ecfdf5;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.new:hover {
		background: #166534;
	}
	.new iconify-icon {
		font-size: 16px;
	}
	:global(.menu) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 200px;
		padding: 6px;
		background: #151516;
		border: 1px solid #2a2a2c;
		border-radius: 12px;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 9px;
		height: 32px;
		padding: 0 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: #d6d3d1;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.mitem:hover {
		background: #212124;
		color: #f5f5f4;
	}
	.mitem.danger {
		color: #fca5a5;
	}
	.mitem iconify-icon {
		font-size: 16px;
		color: #a8a29e;
	}
	.search {
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		outline: none;
	}
	.search:focus {
		border-color: #3f3f46;
	}

	/* ── machines strip ─────────────────────────────────────── */
	.machines {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scrollbar-width: none;
		padding: 0 1px;
	}
	.machines::-webkit-scrollbar {
		display: none;
	}
	.m {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 9px;
		border-radius: 8px;
		border: 1px solid var(--line-soft);
		background: var(--surface);
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.m.on {
		border-color: var(--line);
		background: var(--surface-3);
		color: var(--text);
	}
	.m.wants {
		border-color: #5a4310;
	}
	.m .n {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--green);
		flex: none;
	}
	.dot.off {
		background: var(--faint);
	}
	.mlabel {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 4px 0;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--dim);
	}
	.mlabel::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line-soft);
	}

	/* ── list and cards ─────────────────────────────────────── */
	.list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.empty {
		padding: 18px 10px;
		color: var(--dim);
		font-size: 12.5px;
		text-align: center;
	}
	.link {
		border: 0;
		background: none;
		color: var(--muted);
		text-decoration: underline dotted;
		font: inherit;
		cursor: pointer;
	}
	.proj {
		padding: 5px 5px 5px;
	}
	.proj.wants {
		border-color: #5a4310;
		box-shadow: inset 0 0 0 1px var(--amber-soft);
	}
	.proj.loose {
		border-style: dashed;
	}
	.proj.loose .pname {
		color: var(--dim);
		font-weight: 500;
	}
	.proj-h {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 5px 3px 6px;
	}
	.chip {
		width: 18px;
		height: 18px;
		flex: none;
		border-radius: 6px;
		display: inline-grid;
		place-items: center;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: #0b0b0c;
	}
	.chip.dim {
		background: var(--surface-3);
		color: var(--dim);
	}
	.pname {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		letter-spacing: 0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pcount {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
	}
	.pbtn {
		width: 24px;
		height: 24px;
		flex: none;
		display: inline-grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--dim);
		font-size: 15px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms;
	}
	.proj:hover .pbtn,
	.proj:focus-within .pbtn {
		opacity: 1;
	}
	.pbtn:hover {
		background: var(--surface-3);
		color: var(--text);
	}
	.pclose:hover {
		color: #fca5a5;
	}
	@media (hover: none) {
		.pbtn {
			opacity: 1;
		}
		.pclose {
			display: none;
		}
	}

	/* ── session row ────────────────────────────────────────── */
	.row {
		display: grid;
		grid-template-columns: 16px 1fr auto 14px;
		column-gap: 8px;
		align-items: center;
		padding: 6px 7px;
		border-radius: 9px;
		color: var(--text);
		text-decoration: none;
		position: relative;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.cur {
		background: var(--surface-3);
	}
	.row .st {
		display: grid;
		place-items: center;
		width: 16px;
	}
	.row .st iconify-icon {
		font-size: 13px;
		color: var(--dim);
	}
	.row .name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}
	.row .name.mono {
		font-family: var(--font-mono);
		font-weight: 400;
		color: var(--muted);
		font-size: 12px;
	}
	.row.orch .name {
		color: var(--muted);
	}
	.path {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--dim);
		background: var(--surface-3);
		border-radius: 4px;
		padding: 0 5px;
		margin-right: 4px;
	}
	.row .meta {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.row .when {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
		white-space: nowrap;
	}
	.row .rc {
		font-size: 12px;
		color: #27ae60;
	}
	.pill {
		font-size: 10.5px;
		font-weight: 500;
		color: var(--amber);
		background: var(--amber-soft);
		border-radius: 999px;
		padding: 1px 7px;
		white-space: nowrap;
	}
	.row .sub {
		grid-column: 2 / 5;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
		margin-top: 1px;
	}
	.row .sub.draft {
		color: var(--amber);
	}
	.row .sub iconify-icon {
		font-size: 11px;
		vertical-align: -1px;
		margin-right: 3px;
	}
	.row.tmux {
		padding-top: 5px;
		padding-bottom: 5px;
	}
	.row.tmux .name {
		font-weight: 400;
	}
	/* the kill switch sits over the row's right edge, only when pointed at */
	.kill {
		position: absolute;
		right: 6px;
		top: 4px;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: var(--surface-3);
		color: var(--dim);
		font-size: 13px;
		cursor: pointer;
		opacity: 0;
	}
	.row:hover .kill {
		opacity: 1;
	}
	.kill:hover {
		color: #fca5a5;
	}
	@media (hover: none) {
		.kill {
			display: none;
		}
	}

	/* context ring */
	.ctx {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		position: relative;
		background: conic-gradient(var(--c, var(--green)) calc(var(--p) * 1%), var(--surface-3) 0);
	}
	.ctx::after {
		content: '';
		position: absolute;
		inset: 3.5px;
		border-radius: 50%;
		background: var(--surface);
	}
	.row:hover .ctx::after {
		background: var(--surface-2);
	}
	.row.cur .ctx::after {
		background: var(--surface-3);
	}
	.ctx.warn {
		--c: var(--amber);
	}
	.ctx.hot {
		--c: #ef4444;
	}
	.ctx.none {
		background: transparent;
	}
	.ctx.none::after {
		display: none;
	}

	/* closed sessions, folded */
	.dead {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 7px 2px;
		font-size: 11.5px;
		color: var(--dim);
	}
	.dead .n {
		font-family: var(--font-mono);
	}
	.sweep {
		margin-left: auto;
		border: 0;
		background: none;
		color: var(--dim);
		font: inherit;
		text-decoration: underline dotted;
		cursor: pointer;
	}
	.sweep:hover {
		color: var(--muted);
	}

	/* projects with nothing running */
	.quiet {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 8px;
	}
	.qdead {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--dim);
	}
	.quiet .lbl {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 0 2px 1px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--dim);
	}
	.q {
		display: inline-flex;
		align-items: stretch;
		height: 26px;
		border-radius: 8px;
		background: var(--surface-2);
		border: 1px solid var(--line-soft);
		color: var(--muted);
		font-size: 12px;
		overflow: hidden;
	}
	.q:hover {
		color: var(--text);
		border-color: var(--line);
	}
	.qopen {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px 0 6px;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.q .chip {
		width: 12px;
		height: 12px;
		border-radius: 3px;
	}
	.qx {
		display: none;
		align-items: center;
		padding: 0 6px 0 2px;
		border: 0;
		background: none;
		color: var(--dim);
		font-size: 12px;
		cursor: pointer;
	}
	.q:hover .qx {
		display: inline-flex;
	}
	.qx:hover {
		color: #fca5a5;
	}

	/* agent picker (unchanged from before) */
	.agent-choices {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.agent-choice {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid #2a2a2c;
		border-radius: 10px;
		background: #151516;
		color: #e7e5e4;
		text-align: left;
		cursor: pointer;
	}
	.agent-choice:hover {
		background: #212124;
	}
	.agent-choice iconify-icon {
		font-size: 22px;
	}
	.agent-choice-name {
		font-weight: 500;
	}
	.agent-choice-cmd {
		font-family: var(--font-mono);
		font-size: 11px;
		color: #6b6764;
	}
</style>
