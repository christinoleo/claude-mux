<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { sessionStore, stateColor, getProjectColor, groupSessions, splitPaneTitle, getSessionDisplayName, findDeepestProject, type Session } from '$lib/stores/sessions.svelte';
	import type { TmuxPane } from '../../routes/api/tmux/panes/+server';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ScrollArea } from '$lib/components/ui/scroll-area';

	interface Props {
		onSessionSelect?: () => void;
		compact?: boolean;
	}

	let { onSessionSelect, compact = false }: Props = $props();

	let tmuxPanes = $state<TmuxPane[]>([]);
	let tmuxPanesLoaded = $state(false);
	let showFolderBrowser = $state(false);
	let browserPath = $state('');
	let browserFolders = $state<{ name: string; path: string }[]>([]);
	let browserShowHidden = $state(false);
	let browserIsRoot = $state(false);
	let browserParent = $state<string | null>(null);
	let browserError = $state('');

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

	// Project tree node type
	interface ProjectNode {
		cwd: string;
		sessions: Session[];
		children: ProjectNode[];
		depth: number;
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

	async function fetchTmuxPanes() {
		try {
			const res = await fetch('/api/tmux/panes');
			tmuxPanes = await res.json();
		} catch {
			tmuxPanes = [];
		}
		tmuxPanesLoaded = true;
	}

	onMount(() => {
		sessionStore.loadSavedProjects();
		fetchTmuxPanes();
		let interval: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (interval == null) interval = setInterval(fetchTmuxPanes, 5000);
		};
		const stop = () => {
			if (interval != null) { clearInterval(interval); interval = null; }
		};
		const onVis = () => {
			if (document.hidden) stop();
			else { fetchTmuxPanes(); start(); }
		};
		start();
		document.addEventListener('visibilitychange', onVis);
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVis);
		};
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

	async function newSessionInProject(cwd: string) {
		const res = await fetch('/api/projects/new-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd })
		});
		const data = await res.json();
		if (!data.ok) {
			alert(`Failed to create session: ${data.detail || data.error || 'Unknown error'}`);
			return;
		}
		sessionStore.saveProject(cwd);
		const tmuxTarget = data.tmuxTarget || data.session + ':0.0';
		goto(`/session/${encodeURIComponent(tmuxTarget)}`);
		onSessionSelect?.();
	}

	async function openFolderBrowser() {
		showFolderBrowser = true;
		await browseTo('~');
	}

	async function browseTo(path: string) {
		browserError = '';
		const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}&showHidden=${browserShowHidden}`);
		const data = await res.json();
		if (data.error) {
			browserError = data.error;
			return;
		}
		browserPath = data.current;
		browserFolders = data.folders;
		browserIsRoot = data.isRoot;
		browserParent = data.parent;
	}

	async function selectFolder() {
		showFolderBrowser = false;
		await newSessionInProject(browserPath);
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

	function resetLocalStorage() {
		showConfirm('Reset Local Data', 'This will clear all saved projects, preferences, and cached data. The page will reload.', () => {
			localStorage.removeItem('claude-mux-projects');
			localStorage.removeItem('claude-mux-beads-cache');
			localStorage.removeItem('claude-mux-preferences');
			localStorage.removeItem('claude-mux-sidebar-width');
			window.location.reload();
		});
	}
</script>

{#snippet sessionCard(session: Session, isOrchestrator: boolean, subfolder: string | null)}
	{#if session.tmux_target}
		{@const isActive = session.tmux_target === currentTarget}
		{@const isDead = session.pane_alive === false}
		{@const parsed = session.pane_title ? splitPaneTitle(session.pane_title) : null}
		<a
			href="/session/{encodeURIComponent(session.tmux_target)}"
			class="session"
			class:active={isActive}
			class:orchestrator={isOrchestrator}
			class:dead={isDead}
			onclick={(e) => handleSessionClick(e, session.tmux_target!)}
		>
			<iconify-icon icon="mdi:creation" class="row-prefix claude-prefix" title="Claude session"></iconify-icon>
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
				<div class="session-status">{isDead ? 'pane closed' : (session.current_action || session.state)}</div>
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
				{:else if parsed?.symbol}
					<span class="state-symbol" class:braille={parsed.isBraille} style="color: {stateColor(session.state)}">{parsed.symbol}</span>
				{:else}
					<span class="state-dot" style="background: {stateColor(session.state)}"></span>
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
			<iconify-icon icon="mdi:creation" class="row-prefix claude-prefix"></iconify-icon>
			<div class="session-info">
				<div class="session-name">{session.id}</div>
				<div class="session-status">{session.current_action || session.state}</div>
			</div>
			<div class="session-right">
				<span class="state-dot" style="background: {stateColor(session.state)}"></span>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet tmuxRow(pane: TmuxPane)}
	{@const isActive = pane.target === currentTarget}
	<a
		href="/session/{encodeURIComponent(pane.target)}"
		class="session tmux-row"
		class:active={isActive}
		onclick={(e) => handleSessionClick(e, pane.target)}
	>
		<iconify-icon icon="mdi:console-line" class="row-prefix tmux-prefix" title="tmux pane"></iconify-icon>
		<div class="session-info">
			<div class="session-name">{pane.target}</div>
			{#if !compact}
				<div class="session-status">{pane.command}</div>
			{/if}
		</div>
	</a>
{/snippet}

<div class="all-sessions-panel" class:compact>
	<header class="header">
		<a href="/" class="title-link">
			<h1>claude-mux</h1>
		</a>
		<div class="header-actions">
			{#if !compact}
				<Button
					variant="secondary"
					size="icon"
					onclick={closeChrome}
					title="Close Chrome/Brave debugging instances"
				>
					<iconify-icon icon="mdi:google-chrome"></iconify-icon>
				</Button>
				<Button
					variant="secondary"
					size="icon"
					onclick={resetLocalStorage}
					title="Reset local data (projects, preferences, cache)"
				>
					<iconify-icon icon="mdi:refresh"></iconify-icon>
				</Button>
			{/if}
			<Button
				variant={sessionStore.paused ? 'destructive' : 'secondary'}
				size="icon"
				onclick={() => sessionStore.togglePause()}
				title={sessionStore.paused ? 'Resume' : 'Pause'}
			>
				<iconify-icon icon={sessionStore.paused ? 'mdi:play' : 'mdi:pause'}></iconify-icon>
			</Button>
			<Button variant="secondary" size="icon" onclick={openFolderBrowser} title="New Project">
				<iconify-icon icon="mdi:plus"></iconify-icon>
			</Button>
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
							<button class="project-btn" onclick={() => newSessionInProject(project.cwd)} title="New Session">
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

<Dialog.Root bind:open={showFolderBrowser}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Select Folder</Dialog.Title>
		</Dialog.Header>
		<div class="fb-path">
			{browserPath}
		</div>
		{#if browserError}
			<p class="text-sm text-destructive">{browserError}</p>
		{/if}
		<div class="flex items-center gap-2 py-2">
			<Checkbox id="show-hidden" checked={browserShowHidden} onCheckedChange={(v) => { browserShowHidden = !!v; browseTo(browserPath); }} />
			<label for="show-hidden" class="text-sm text-muted-foreground cursor-pointer">Show hidden</label>
		</div>
		<ScrollArea class="h-64 rounded-md border">
			<div class="p-2">
				{#if !browserIsRoot && browserParent}
					<button class="fb-item" onclick={() => browseTo(browserParent!)}>
						<iconify-icon icon="mdi:folder-arrow-up"></iconify-icon>
						..
					</button>
				{/if}
				{#each browserFolders as folder}
					<button class="fb-item" onclick={() => browseTo(folder.path)}>
						<iconify-icon icon="mdi:folder"></iconify-icon>
						{folder.name}
					</button>
				{/each}
			</div>
		</ScrollArea>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showFolderBrowser = false}>Cancel</Button>
			<Button onclick={selectFolder}>Select</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

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

	.title-link {
		text-decoration: none;
		color: inherit;
	}

	.title-link:hover h1 {
		color: hsl(var(--primary));
	}

	.header h1 {
		font-size: 16px;
		margin: 0;
		transition: color 0.15s;
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

	.session-right {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.state-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.state-symbol {
		font-size: 14px;
		line-height: 1;
		flex-shrink: 0;
		font-variant-emoji: text;
	}

	.state-symbol.braille {
		font-size: 20px;
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

	.claude-prefix {
		color: #d97757;
	}

	.tmux-prefix {
		color: #5a6978;
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

	/* Folder browser items */
	.fb-path {
		padding: 10px;
		background: hsl(var(--muted));
		font-family: monospace;
		font-size: 13px;
		color: hsl(var(--muted-foreground));
		word-break: break-all;
		border-radius: 6px;
		margin-bottom: 8px;
	}

	.fb-item {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		color: hsl(var(--foreground));
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		border-radius: 6px;
	}

	.fb-item:hover {
		background: hsl(var(--accent));
	}

	/* Compact mode adjustments */
	.compact .header {
		padding: 10px 12px;
	}

	.compact .header h1 {
		font-size: 14px;
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

	.compact .state-dot {
		width: 7px;
		height: 7px;
	}
</style>
