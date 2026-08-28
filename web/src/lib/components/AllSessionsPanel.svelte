<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { sessionStore, getProjectColor, groupSessions, getSessionDisplayName, findDeepestProject, type Session } from '$lib/stores/sessions.svelte';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';
	import { tmuxPanesStore } from '$lib/stores/tmuxPanes.svelte';
	import { draftsStore } from '$lib/stores/drafts.svelte';
	import { AGENTS, AGENT_IDS } from '$shared/agents.js';
	import type { SessionAgent } from '$shared/db/index.js';
	import type { TmuxPane } from '$lib/types/tmux';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
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

	const tmuxPanes = $derived(tmuxPanesStore.panes);
	const tmuxPanesLoaded = $derived(tmuxPanesStore.loaded);
	let showFolderBrowser = $state(false);
	let folderPicker = $state<FolderPicker | null>(null);

	// AlertDialog state
	let alertOpen = $state(false);
	let alertTitle = $state('');
	let alertMessage = $state('');
	let alertOnConfirm = $state<() => void>(() => {});

	function showConfirm(title: string, message: string, onConfirm: () => void) {
		alertTitle = title;
		alertMessage = message;
		alertOnConfirm = onConfirm;
		alertOpen = true;
	}

	// A session row is a link, so a double-click opens naming for the session you
	// just landed on rather than needing a trip to its header.
	let renameId = $state<string | null>(null);

	/**
	 * One click opens the session, two open the rename dialog — the touch
	 * equivalent is the `longPress` action on the same row. The second click is
	 * matched on `detail` rather than with a `dblclick` listener, because the first
	 * click navigates and re-renders the row, leaving the browser without a shared
	 * target to fire `dblclick` on.
	 */
	function handleSessionRowClick(e: MouseEvent, session: Session) {
		if (e.detail >= 2) {
			e.preventDefault();
			renameId = session.id;
			return;
		}
		handleSessionClick(e, session.tmux_target!);
	}

	let agentPickerCwd = $state<string | null>(null);

	function pickAgent(agent: SessionAgent) {
		const cwd = agentPickerCwd;
		agentPickerCwd = null;
		if (cwd) newSessionInProject(cwd, agent);
	}

	// Project tree node type
	interface ProjectNode {
		cwd: string;
		sessions: Session[];
		children: ProjectNode[];
		depth: number;
	}

	function detectPaneAgent(command: string): SessionAgent | null {
		const cmd = command.toLowerCase();
		for (const id of AGENT_IDS) {
			if (cmd.includes(id)) return id;
		}
		return null;
	}

	// Group sessions by project (cwd)
	const sessionsByProject = $derived.by(() => {
		const groups = new Map<string, Session[]>();
		for (const session of sessionStore.sessions) {
			const key = session.cwd || 'unknown';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(session);
		}
		return groups;
	});

	const recencyRanks = $derived.by(() => {
		const ranks = new Map<string, number>();
		for (const sessions of sessionsByProject.values()) {
			if (sessions.length < 2) continue;
			const sorted = [...sessions].sort((a, b) => (b.last_update ?? 0) - (a.last_update ?? 0));
			sorted.forEach((s, i) => ranks.set(s.id, i + 1));
		}
		return ranks;
	});

	// Get all projects (from sessions + saved)
	const allProjects = $derived.by(() => {
		const projects = new Set<string>();
		for (const session of sessionStore.sessions) {
			if (session.cwd) projects.add(session.cwd);
		}
		for (const cwd of sessionStore.savedProjects) {
			projects.add(cwd);
		}
		return [...projects].sort();
	});

	// Flatten tree for rendering with depth info
	function flattenTree(nodes: ProjectNode[]): ProjectNode[] {
		const result: ProjectNode[] = [];
		for (const node of nodes) {
			result.push(node);
			if (node.children.length > 0) {
				result.push(...flattenTree(node.children));
			}
		}
		return result;
	}

	// Build project tree with parent/child relationships
	const projectTree = $derived.by(() => {
		const projects = allProjects;
		const sessionsMap = sessionsByProject;

		// Sort by path length (shorter = potential parents)
		const sorted = [...projects].sort((a, b) => a.length - b.length);

		const roots: ProjectNode[] = [];
		const nodeMap = new Map<string, ProjectNode>();

		for (const cwd of sorted) {
			const node: ProjectNode = {
				cwd,
				sessions: sessionsMap.get(cwd) || [],
				children: [],
				depth: 0
			};

			// Find parent (longest matching prefix that's also a project)
			let parent: ProjectNode | null = null;
			for (const potentialParent of sorted) {
				if (potentialParent === cwd) continue;
				if (cwd.startsWith(potentialParent + '/')) {
					const parentNode = nodeMap.get(potentialParent);
					if (parentNode && (!parent || potentialParent.length > parent.cwd.length)) {
						parent = parentNode;
					}
				}
			}

			if (parent) {
				node.depth = parent.depth + 1;
				parent.children.push(node);
			} else {
				roots.push(node);
			}

			nodeMap.set(cwd, node);
		}

		return roots;
	});

	const flatProjects = $derived.by(() => flattenTree(projectTree));

	const nonClaudeTmuxPanes = $derived.by(() => {
		const claudeTargets = new Set(sessionStore.sessions.map(s => s.tmux_target));
		return tmuxPanes.filter(p => !claudeTargets.has(p.target));
	});

	// Bucket each non-Claude pane under its deepest matching project cwd;
	// panes under no known project fall into `orphans`.
	const tmuxByProject = $derived.by(() => {
		const byProject = new Map<string, TmuxPane[]>();
		const orphans: TmuxPane[] = [];
		for (const pane of nonClaudeTmuxPanes) {
			const match = pane.cwd ? findDeepestProject(pane.cwd, allProjects) : null;
			if (match) {
				if (!byProject.has(match)) byProject.set(match, []);
				byProject.get(match)!.push(pane);
			} else {
				orphans.push(pane);
			}
		}
		return { byProject, orphans };
	});

	// Check if a session is currently active (matches current route)
	const currentTarget = $derived($page.url.pathname.startsWith('/session/')
		? decodeURIComponent($page.url.pathname.split('/session/')[1])
		: null);

	onMount(() => {
		sessionStore.loadSavedProjects();
		return tmuxPanesStore.subscribe();
	});

	// Auto-persist any project we see a session in, so the group doesn't
	// disappear when the last pane in it is closed.
	$effect(() => {
		for (const session of sessionStore.sessions) {
			if (session.cwd) sessionStore.saveProject(session.cwd);
		}
	});

	function killSessionReq(s: { id: string; pid: number; tmux_target: string | null }) {
		return fetch(`/api/sessions/${encodeURIComponent(s.id)}/kill`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pid: s.pid, tmux_target: s.tmux_target })
		});
	}

	function killSession(id: string, pid: number, tmux_target: string | null) {
		showConfirm('Kill Session', 'Are you sure you want to kill this session?', () => {
			killSessionReq({ id, pid, tmux_target });
		});
	}

	function dismissSession(id: string, pid: number, tmux_target: string | null) {
		killSessionReq({ id, pid, tmux_target });
	}

	function closeProject(cwd: string, sessions: Session[]) {
		const count = sessions.length;
		const msg = count > 0
			? `Kill ${count} session${count === 1 ? '' : 's'} in this project and remove the group?`
			: 'Remove this empty project group?';
		showConfirm('Close Project', msg, async () => {
			await Promise.all(sessions.map(killSessionReq));
			sessionStore.removeProject(cwd);
		});
	}

	async function newSessionInProject(cwd: string, agent: SessionAgent = 'claude') {
		const res = await fetch('/api/projects/new-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd, agent })
		});
		const data = await res.json();
		if (!data.ok) {
			alert(`Failed to create session: ${data.detail || data.error || 'Unknown error'}`);
			return;
		}
		sessionStore.saveProject(cwd);
		if (data.record) sessionStore.optimisticAdd(data.record);
		const tmuxTarget = data.tmuxTarget || data.session + ':0.0';
		goto(`/session/${encodeURIComponent(tmuxTarget)}`);
		onSessionSelect?.();
	}

	function openFolderBrowser() {
		void folderPicker?.openAt();
	}

	function getProjectName(cwd: string): string {
		return cwd.split('/').pop() || cwd;
	}

	function handleSessionClick(e: MouseEvent, tmuxTarget: string) {
		e.preventDefault();
		goto(`/session/${encodeURIComponent(tmuxTarget)}`);
		onSessionSelect?.();
	}

	async function closeChrome() {
		await fetch('/api/chrome', { method: 'DELETE' });
	}

	const RESET_KEEP_KEYS = new Set<string>([STORAGE_KEYS.lastSession]);

	function resetLocalStorage() {
		showConfirm('Reset Local Data', 'This will clear all saved projects, preferences, and cached data. The page will reload.', () => {
			for (let i = localStorage.length - 1; i >= 0; i--) {
				const key = localStorage.key(i);
				if (key && key.startsWith('claude-mux-') && !RESET_KEEP_KEYS.has(key)) {
					localStorage.removeItem(key);
				}
			}
			window.location.reload();
		});
	}

	const sidebarActions: ChordAction[] = $derived([
		{ label: 'Usage', icon: 'mdi:chart-line', run: () => void goto('/usage') },
		{ label: 'Close Chrome', icon: 'mdi:google-chrome', run: () => void closeChrome() },
		{ label: 'Refresh', icon: 'mdi:refresh', run: () => location.reload() },
		{ label: 'Reset data', icon: 'mdi:database-refresh', run: () => resetLocalStorage(), danger: true },
		{
			label: sessionStore.paused ? 'Resume' : 'Pause',
			icon: sessionStore.paused ? 'mdi:play' : 'mdi:pause',
			run: () => sessionStore.togglePause(),
			variant: sessionStore.paused ? 'destructive' : 'secondary'
		},
		{ label: 'New project', icon: 'mdi:plus', run: () => void openFolderBrowser() }
	]);

	$effect(() => {
		sidebarActionsStore.set(sidebarActions);
	});
</script>

{#snippet rankBadge(rank: number | undefined)}
	{#if rank !== undefined}<span class="rank" class:rank-top={rank === 1}>{rank}</span>{/if}
{/snippet}

{#snippet sessionCard(session: Session, isOrchestrator: boolean, subfolder: string | null)}
	{@const agentMeta = AGENTS[session.agent ?? 'claude']}
	{@const rank = !isOrchestrator ? recencyRanks.get(session.id) : undefined}
	{#if session.tmux_target}
		{@const isActive = session.tmux_target === currentTarget}
		{@const isDead = session.pane_alive === false}
		{@const draft = !isActive && !isDead ? draftsStore.get(session.tmux_target) : ''}
		{@const hasDraft = draft.length > 0}
		<a
			href="/session/{encodeURIComponent(session.tmux_target)}"
			class="session"
			class:active={isActive}
			class:orchestrator={isOrchestrator}
			class:dead={isDead}
			class:has-draft={hasDraft}
			onclick={(e) => handleSessionRowClick(e, session)}
			use:longPress={{ onTrigger: () => (renameId = session.id) }}
			title="Double-click or long-press to rename"
		>
			<iconify-icon icon={agentMeta.icon} class="row-prefix" style="color: {agentMeta.color};" title={agentMeta.label}></iconify-icon>
			<div class="session-info">
				{#if isOrchestrator}
					<span class="session-role">orch</span>
				{/if}
				<div class="session-name">
					{#if subfolder}
						<span class="subfolder-icon" title={subfolder}>└</span>
					{/if}
					{getSessionDisplayName(session)}
				</div>
				{#if hasDraft}
					<div class="session-status draft-status" title={draft}>
						{@render rankBadge(rank)}
						<iconify-icon icon="mdi:pencil-outline"></iconify-icon>
						<span class="draft-preview">{draftsStore.preview(session.tmux_target)}</span>
					</div>
				{:else}
					<div class="session-status">
						{@render rankBadge(rank)}
						{isDead ? 'pane closed' : (session.current_action || session.state)}
					</div>
				{/if}
			</div>
			<div class="session-right">
				{#if session.rc_url}
					<iconify-icon icon="mdi:cellphone-link" style="color: #27ae60; font-size: 12px;" title="Remote Control active"></iconify-icon>
				{/if}
				{#if isDead}
					<button
						class="kill-btn dismiss-btn"
						onclick={(e) => { e.preventDefault(); e.stopPropagation(); dismissSession(session.id, session.pid, session.tmux_target); }}
						title="Dismiss"
					>
						<iconify-icon icon="mdi:close-circle" style="font-size: 13px;"></iconify-icon>
					</button>
				{:else}
					<SessionStateIndicator
						state={session.state}
						size={compact ? 'sm' : 'md'}
						title={session.current_action}
					/>
				{/if}
				{#if !compact && !isDead}
					<button
						class="kill-btn"
						onclick={(e) => { e.preventDefault(); e.stopPropagation(); killSession(session.id, session.pid, session.tmux_target); }}
						title="Kill"
					>
						<iconify-icon icon="mdi:power"></iconify-icon>
					</button>
				{/if}
			</div>
		</a>
	{:else}
		<div class="session no-tmux" class:orchestrator={isOrchestrator}>
			<iconify-icon icon={agentMeta.icon} class="row-prefix" style="color: {agentMeta.color};"></iconify-icon>
			<div class="session-info">
				<div class="session-name">{session.id}</div>
				<div class="session-status">{session.current_action || session.state}</div>
			</div>
			<div class="session-right">
				<SessionStateIndicator state={session.state} size={compact ? 'sm' : 'md'} />
			</div>
		</div>
	{/if}
{/snippet}

{#snippet tmuxRow(pane: TmuxPane)}
	{@const isActive = pane.target === currentTarget}
	{@const detected = detectPaneAgent(pane.command || '')}
	{@const meta = detected ? AGENTS[detected] : null}
	{@const draft = !isActive ? draftsStore.get(pane.target) : ''}
	{@const hasDraft = draft.length > 0}
	<a
		href="/session/{encodeURIComponent(pane.target)}"
		class="session"
		class:tmux-row={!meta}
		class:agent-row={!!meta}
		class:active={isActive}
		class:has-draft={hasDraft}
		onclick={(e) => handleSessionClick(e, pane.target)}
	>
		<iconify-icon
			icon={meta?.icon ?? 'mdi:console-line'}
			class="row-prefix"
			class:tmux-prefix={!meta}
			style={meta ? `color: ${meta.color};` : undefined}
			title={meta?.label ?? 'tmux pane'}
		></iconify-icon>
		<div class="session-info">
			<div class="session-name">{pane.target}</div>
			{#if hasDraft}
				<div class="session-status draft-status" title={draft}>
					<iconify-icon icon="mdi:pencil-outline"></iconify-icon>
					<span class="draft-preview">{draftsStore.preview(pane.target)}</span>
				</div>
			{:else if !compact}
				<div class="session-status">{meta?.label ?? pane.command}</div>
			{/if}
		</div>
	</a>
{/snippet}

<div class="all-sessions-panel" class:compact>
	<header class="header">
		<ServerPicker />
		<div class="header-actions">
			{#each sidebarActions as action (action.label)}
				<Button
					variant={action.variant ?? 'secondary'}
					size="icon-sm"
					onclick={action.run}
					title={action.label}
					class={action.danger ? 'text-red-400 hover:bg-red-950/40 hover:text-red-300' : ''}
				>
					<iconify-icon icon={action.icon}></iconify-icon>
				</Button>
			{/each}
		</div>
	</header>

	<div class="scroll-content">
		{#if flatProjects.length === 0}
			<div class="empty">No sessions yet. Click + to add a project.</div>
		{:else}
			{#each flatProjects.filter(p => p.depth === 0) as project (project.cwd)}
				{@const color = getProjectColor(project.cwd)}
				{@const grouped = groupSessions(project.sessions)}
				{@const childProjects = flatProjects.filter(p => p.depth > 0 && p.cwd.startsWith(project.cwd + '/'))}
				<div class="project-group" style="border-left-color: {color}">
					<div class="project-header">
						<div class="project-label">
							<span class="project-name" style="color: {color}">{getProjectName(project.cwd)}</span>
						</div>
						<div class="project-actions">
							<button
								class="project-btn"
								onclick={() => newSessionInProject(project.cwd)}
								oncontextmenu={(e) => { e.preventDefault(); agentPickerCwd = project.cwd; }}
								use:longPress={{ onTrigger: () => (agentPickerCwd = project.cwd) }}
								title="New Session (right-click or long-press for agent)"
							>
								<iconify-icon icon="mdi:plus"></iconify-icon>
							</button>
							<button class="project-btn project-close" onclick={() => closeProject(project.cwd, project.sessions)} title="Close Project">
								<iconify-icon icon="mdi:close"></iconify-icon>
							</button>
						</div>
					</div>
					{#each grouped as item (item.type === 'pair' ? item.main.id : item.session.id)}
						{#if item.type === 'pair'}
							<div class="session-pair">
								{@render sessionCard(item.main, false, null)}
								{@render sessionCard(item.orchestrator, true, null)}
							</div>
						{:else}
							{@render sessionCard(item.session, false, null)}
						{/if}
					{/each}
					{#each childProjects as child (child.cwd)}
						{@const childGrouped = groupSessions(child.sessions)}
						{#each childGrouped as item (item.type === 'pair' ? item.main.id : item.session.id)}
							{@const subPath = child.cwd.slice(project.cwd.length + 1)}
							{#if item.type === 'pair'}
								<div class="session-pair">
									{@render sessionCard(item.main, false, subPath)}
									{@render sessionCard(item.orchestrator, true, subPath)}
								</div>
							{:else}
								{@render sessionCard(item.session, false, subPath)}
							{/if}
						{/each}
						{#each (tmuxByProject.byProject.get(child.cwd) || []) as pane (pane.target)}
							{@render tmuxRow(pane)}
						{/each}
					{/each}
					{#each (tmuxByProject.byProject.get(project.cwd) || []) as pane (pane.target)}
						{@render tmuxRow(pane)}
					{/each}
				</div>
			{/each}
		{/if}

		{#if tmuxPanesLoaded && tmuxByProject.orphans.length > 0}
			<div class="orphan-group">
				<div class="orphan-header">
					<iconify-icon icon="mdi:console-line"></iconify-icon>
					<span>other tmux</span>
					<span class="orphan-count">{tmuxByProject.orphans.length}</span>
				</div>
				{#each tmuxByProject.orphans as pane (pane.target)}
					{@render tmuxRow(pane)}
				{/each}
			</div>
		{/if}
	</div>
</div>

<FolderPicker
	bind:this={folderPicker}
	bind:open={showFolderBrowser}
	onpick={(cwd) => newSessionInProject(cwd)}
/>

<Dialog.Root open={agentPickerCwd !== null} onOpenChange={(o) => { if (!o) agentPickerCwd = null; }}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>New Session</Dialog.Title>
			<Dialog.Description>Choose which agent to launch.</Dialog.Description>
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
	.all-sessions-panel {
		display: flex;
		flex-direction: column;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		border-bottom: 1px solid #222;
		flex-shrink: 0;
		position: sticky;
		top: 0;
		z-index: 1;
		background: hsl(var(--background));
	}

	.header-actions {
		display: flex;
		gap: 6px;
	}

	.scroll-content {
		padding: 8px 0;
	}

	.empty {
		color: hsl(var(--muted-foreground));
		text-align: center;
		padding: 40px 16px;
		font-size: 13px;
	}

	/* Project group: minimal colored left border */
	.project-group {
		border-left: 2px solid;
		margin: 0 8px 12px 8px;
	}

	/* Project header: just colored text + hover add button */
	.project-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px 2px;
	}

	.project-label {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.project-name {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-actions {
		display: flex;
		gap: 2px;
	}

	.project-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border: none;
		background: none;
		color: #555;
		cursor: pointer;
		border-radius: 4px;
		font-size: 14px;
		opacity: 0;
		transition: opacity 0.15s, background 0.15s, color 0.15s;
	}

	.project-header:hover .project-btn {
		opacity: 1;
	}

	.project-btn:hover {
		background: #333;
		color: #fff;
	}

	.project-close:hover {
		color: #e74c3c;
	}

	/* Session row: RC-style two-line layout */
	.session {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		text-decoration: none;
		color: inherit;
		transition: background 0.1s;
		cursor: pointer;
		/* Rows are navigation, not prose — this also stops the rename
		   double-click from leaving the label highlighted. */
		user-select: none;
	}

	.session:hover {
		background: #1a1a1a;
	}

	.session.active {
		background: color-mix(in oklch, var(--primary), transparent 80%);
	}

	.session.active .session-name {
		color: var(--primary);
	}

	.session-info {
		flex: 1;
		min-width: 0;
	}

	.session-name {
		font-weight: 600;
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.3;
		display: flex;
		align-items: center;
		gap: 4px;
		font-variant-emoji: text;
	}

	.subfolder-icon {
		font-family: monospace;
		font-size: 11px;
		color: #666;
		flex-shrink: 0;
		cursor: help;
	}

	.session-status {
		color: #777;
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.3;
	}

	.session-status.draft-status {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--draft-color);
		font-style: italic;
		font-size: 11px;
	}

	.session-status.draft-status iconify-icon {
		font-size: 11px;
		opacity: 0.85;
		flex-shrink: 0;
	}

	.draft-preview {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.session.has-draft {
		--draft-color: #e8b35c;
		box-shadow: inset 2px 0 0 0 color-mix(in oklch, var(--draft-color) 55%, transparent);
	}

	.session.has-draft:hover {
		box-shadow: inset 2px 0 0 0 var(--draft-color);
	}

	.session-right {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.rank {
		display: inline-block;
		font-size: 10px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: #8a8a8a;
		letter-spacing: 0.02em;
		flex-shrink: 0;
		margin-right: 4px;
	}

	.rank.rank-top {
		color: #b8e0c2;
	}

	.rank::after {
		content: '·';
		color: #555;
		margin-left: 4px;
		font-weight: 400;
	}

	.session.active .rank {
		color: #c8c8c8;
	}

	.session.active .rank.rank-top {
		color: #d4f0dc;
	}

	.kill-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border: none;
		background: none;
		color: #555;
		cursor: pointer;
		border-radius: 4px;
		font-size: 13px;
		opacity: 0;
		transition: opacity 0.15s, color 0.15s;
	}

	.session:hover .kill-btn {
		opacity: 1;
	}

	.kill-btn:hover {
		color: #e74c3c;
	}

	.dismiss-btn {
		opacity: 0.6;
	}
	.dismiss-btn:hover {
		opacity: 1;
	}

	/* Orchestrator: dimmer */
	.session.orchestrator {
		padding-left: 20px;
		opacity: 0.6;
	}

	.session.orchestrator:hover {
		opacity: 0.8;
	}

	.session-role {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #555;
		line-height: 1;
	}

	/* Session pair: stacked */
	.session-pair {
		display: flex;
		flex-direction: column;
	}

	/* Dead pane */
	.session.dead {
		opacity: 0.4;
	}

	.session.dead .session-name {
		text-decoration: line-through;
		color: #666;
	}

	.session.no-tmux {
		cursor: default;
		opacity: 0.5;
	}

	.row-prefix {
		font-size: 12px;
		flex-shrink: 0;
		width: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	.tmux-prefix {
		color: #5a6978;
	}

	.session.agent-row .session-name {
		font-weight: 600;
		color: inherit;
		font-family: inherit;
		font-size: 13px;
	}

	.session.agent-row .session-status {
		color: #777;
		font-family: inherit;
	}

	.session.tmux-row .session-name {
		font-weight: 500;
		color: #bbb;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
	}

	.session.tmux-row .session-status {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.orphan-group {
		border-left: 2px solid #2a2a2a;
		margin: 16px 8px 12px 8px;
	}

	.orphan-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px 4px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.8px;
		color: #666;
		font-weight: 600;
	}

	.orphan-header iconify-icon {
		font-size: 12px;
	}

	.orphan-count {
		margin-left: auto;
		font-size: 10px;
		color: #555;
		letter-spacing: 0;
	}

	.agent-choices {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 4px 0;
	}

	.agent-choice {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 10px 12px;
		background: transparent;
		border: 1px solid hsl(var(--border));
		color: hsl(var(--foreground));
		text-align: left;
		cursor: pointer;
		border-radius: 6px;
		transition: background 0.1s, border-color 0.1s;
	}

	.agent-choice:hover {
		background: hsl(var(--accent));
		border-color: hsl(var(--primary));
	}

	.agent-choice iconify-icon {
		font-size: 22px;
		flex-shrink: 0;
	}

	.agent-choice-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.agent-choice-name {
		font-size: 13px;
		font-weight: 600;
	}

	.agent-choice-cmd {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 11px;
		color: hsl(var(--muted-foreground));
	}

	/* Compact mode adjustments */
	.compact .header {
		padding: 10px 12px;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
	}


	.compact .scroll-content {
		padding: 4px 0;
	}

	.compact .project-group {
		margin: 0 4px 8px 4px;
	}

	.compact .project-header {
		padding: 2px 6px 1px;
	}

	.compact .session {
		padding: 4px 8px;
	}

	.compact .session-name {
		font-size: 12px;
	}

	.compact .session-status {
		font-size: 10px;
	}

</style>
