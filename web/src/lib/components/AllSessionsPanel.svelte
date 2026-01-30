<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { sessionStore, stateColor, getProjectColor, type Session } from '$lib/stores/sessions.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ScrollArea } from '$lib/components/ui/scroll-area';

	interface Props {
		onSessionSelect?: () => void;
		compact?: boolean;
	}

	let { onSessionSelect, compact = false }: Props = $props();

	interface TmuxPane {
		target: string;
		session: string;
		command: string;
	}

	let tmuxPanes = $state<TmuxPane[]>([]);
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

	// Filter tmux panes to exclude Claude sessions
	const otherTmuxPanes = $derived.by(() => {
		const claudeTargets = new Set(sessionStore.sessions.map(s => s.tmux_target));
		return tmuxPanes.filter(p => !claudeTargets.has(p.target));
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
	}

	onMount(() => {
		sessionStore.loadSavedProjects();
		fetchTmuxPanes();
	});

	function killSession(id: string, pid: number, tmux_target: string | null) {
		showConfirm('Kill Session', 'Are you sure you want to kill this session?', async () => {
			await fetch(`/api/sessions/${encodeURIComponent(id)}/kill`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pid, tmux_target })
			});
		});
	}

	function deleteProject(cwd: string) {
		showConfirm('Delete Project', `Delete project "${cwd}" and all its sessions?`, async () => {
			// Kill all sessions in this project
			const sessions = sessionsByProject.get(cwd) || [];
			for (const s of sessions) {
				await fetch(`/api/sessions/${encodeURIComponent(s.id)}/kill`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ pid: s.pid, tmux_target: s.tmux_target })
				});
			}
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
		sessionStore.saveProject(cwd);
		if (data.ok && data.session) {
			const tmuxTarget = data.session + ':1.1';
			goto(`/session/${encodeURIComponent(tmuxTarget)}`);
			onSessionSelect?.();
		}
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
</script>

<div class="all-sessions-panel" class:compact>
	<header class="header">
		<a href="/" class="title-link">
			<h1>claude-watch</h1>
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

	<p class="count">{sessionStore.sessions.length} session{sessionStore.sessions.length !== 1 ? 's' : ''}</p>

	<div class="scroll-content">
		{#if flatProjects.length === 0}
			<div class="empty">No sessions yet. Click + to add a project.</div>
		{:else}
			{#each flatProjects as project}
				{@const color = getProjectColor(project.cwd)}
				{@const isNested = project.depth > 0}
				{@const firstSession = project.sessions[0]}
				<div class="project-group" class:nested={isNested} style="margin-left: {project.depth * (compact ? 16 : 24)}px; border-left-color: {color}">
					<div class="project-header">
						<div class="project-info">
							{#if isNested}
								<span class="nest-indicator">└</span>
							{/if}
							<span class="name">{getProjectName(project.cwd)}</span>
							<div class="meta">
								<Badge variant="secondary" class="text-xs">{project.sessions.length}</Badge>
								{#if !compact}
									{#if firstSession?.git_root}<Badge variant="outline" class="border-orange-700 text-orange-400">git</Badge>{/if}
									{#if firstSession?.beads_enabled}<Badge variant="outline" class="border-purple-700 text-purple-400">beads</Badge>{/if}
								{/if}
							</div>
						</div>
						<div class="project-actions">
							<Button variant="ghost" size="icon-sm" onclick={() => newSessionInProject(project.cwd)} title="New Session">
								<iconify-icon icon="mdi:plus"></iconify-icon>
							</Button>
							{#if !compact}
								<Button variant="ghost" size="icon-sm" class="hover:bg-red-900/50 hover:text-red-300" onclick={() => deleteProject(project.cwd)} title="Delete Project">
									<iconify-icon icon="mdi:delete"></iconify-icon>
								</Button>
							{/if}
						</div>
					</div>
					<div class="project-sessions">
						{#each project.sessions as session}
							{#if session.tmux_target}
								{@const isActive = session.tmux_target === currentTarget}
								<a
									href="/session/{encodeURIComponent(session.tmux_target)}"
									class="session {session.state}"
									class:active={isActive}
									onclick={(e) => handleSessionClick(e, session.tmux_target!)}
								>
									<span class="state" style="background: {stateColor(session.state)}"></span>
									<div class="session-info">
										<div class="target">{session.pane_title || session.tmux_target}</div>
										<div class="action">{session.current_action || session.state}</div>
									</div>
									{#if !compact}
										<div class="actions">
											<Button
												variant="ghost-destructive"
												size="icon-sm"
												onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); killSession(session.id, session.pid, session.tmux_target); }}
												title="Kill"
											>
												<iconify-icon icon="mdi:power"></iconify-icon>
											</Button>
										</div>
									{/if}
								</a>
							{:else}
								<div class="session {session.state} no-tmux">
									<span class="state" style="background: {stateColor(session.state)}"></span>
									<div class="session-info">
										<div class="target">{session.id}</div>
										<div class="action">{session.current_action || session.state}</div>
										<div class="no-tmux-label">No tmux pane</div>
									</div>
									{#if !compact}
										<div class="actions">
											<Button
												variant="ghost-destructive"
												size="icon-sm"
												onclick={() => killSession(session.id, session.pid, session.tmux_target)}
												title="Kill"
											>
												<iconify-icon icon="mdi:power"></iconify-icon>
											</Button>
										</div>
									{/if}
								</div>
							{/if}
						{:else}
							<div class="empty-project">No active sessions</div>
						{/each}
					</div>
				</div>
			{/each}
		{/if}

		{#if otherTmuxPanes.length > 0}
			<div class="other-tmux">
				<div class="other-tmux-header">
					<h2>Other tmux</h2>
					<Button variant="ghost" size="icon-sm" onclick={fetchTmuxPanes} title="Refresh">
						<iconify-icon icon="mdi:refresh"></iconify-icon>
					</Button>
				</div>
				<div class="other-tmux-list">
					{#each otherTmuxPanes as pane}
						<a
							href="/session/{encodeURIComponent(pane.target)}"
							class="tmux-pane"
							onclick={(e) => handleSessionClick(e, pane.target)}
						>
							<iconify-icon icon="mdi:console" class="pane-icon"></iconify-icon>
							<div class="pane-info">
								<span class="pane-target">{pane.target}</span>
								{#if !compact}
									<span class="pane-command">{pane.command}</span>
								{/if}
							</div>
						</a>
					{/each}
				</div>
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
		height: 100%;
		overflow: hidden;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px;
		padding-bottom: 12px;
		border-bottom: 1px solid hsl(var(--border));
		flex-shrink: 0;
	}

	.title-link {
		text-decoration: none;
		color: inherit;
	}

	.title-link:hover h1 {
		color: hsl(var(--primary));
	}

	.header h1 {
		font-size: 18px;
		margin: 0;
		transition: color 0.15s;
	}

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.count {
		color: hsl(var(--muted-foreground));
		font-size: 13px;
		margin: 0;
		padding: 8px 16px;
		flex-shrink: 0;
	}

	.scroll-content {
		flex: 1;
		overflow-y: auto;
		padding: 0 12px 12px;
	}

	.empty {
		color: hsl(var(--muted-foreground));
		text-align: center;
		padding: 40px 16px;
		font-size: 14px;
	}

	.project-group {
		margin-bottom: 16px;
		border-left: 3px solid;
		border-radius: 6px;
		overflow: hidden;
	}

	.project-group.nested {
		margin-bottom: 10px;
		margin-top: -6px;
	}

	.project-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		background: #292524;
	}

	.project-info {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.nest-indicator {
		font-family: monospace;
		color: hsl(var(--muted-foreground));
		margin-right: -2px;
		font-size: 12px;
	}

	.project-header .name {
		font-weight: 600;
		font-size: 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-header .meta {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.project-actions {
		display: flex;
		gap: 2px;
		opacity: 0.5;
		transition: opacity 0.15s;
	}

	.project-header:hover .project-actions {
		opacity: 1;
	}

	.project-sessions .session {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px;
		padding-left: 10px;
		background: #111;
		border-top: 1px solid #222;
		text-decoration: none;
		color: inherit;
		transition: background 0.15s;
	}

	.project-sessions .session:hover {
		background: #1a1a1a;
	}

	.project-sessions .session.active {
		background: color-mix(in oklch, var(--primary), transparent 75%);
		border-left: 4px solid var(--primary);
		padding-left: 6px;
		box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary), transparent 70%);
	}

	.project-sessions .session.active .target {
		color: var(--primary);
	}

	.session .state {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.session-info {
		flex: 1;
		min-width: 0;
	}

	.session .target {
		font-weight: 600;
		font-size: 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session .action {
		color: hsl(var(--muted-foreground));
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session.no-tmux {
		cursor: default;
		opacity: 0.7;
	}

	.no-tmux-label {
		color: hsl(var(--muted-foreground));
		font-size: 11px;
		font-style: italic;
	}

	.empty-project {
		padding: 12px;
		background: #111;
		color: hsl(var(--muted-foreground));
		text-align: center;
		font-size: 13px;
		border-radius: 0 0 6px 6px;
	}

	.actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	/* Folder browser items */
	.fb-path {
		padding: 12px;
		background: hsl(var(--muted));
		font-family: monospace;
		font-size: 14px;
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
		padding: 10px 12px;
		background: transparent;
		border: none;
		color: hsl(var(--foreground));
		font-size: 14px;
		text-align: left;
		cursor: pointer;
		border-radius: 6px;
	}

	.fb-item:hover {
		background: hsl(var(--accent));
	}

	/* Other tmux section */
	.other-tmux {
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid #333;
	}

	.other-tmux-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}

	.other-tmux-header h2 {
		font-size: 14px;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
		margin: 0;
	}

	.other-tmux-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.tmux-pane {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		background: #1a1a1a;
		border-radius: 6px;
		text-decoration: none;
		color: inherit;
		transition: background 0.15s;
	}

	.tmux-pane:hover {
		background: #252525;
	}

	.pane-icon {
		color: hsl(var(--muted-foreground));
		font-size: 16px;
		flex-shrink: 0;
	}

	.pane-info {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.pane-target {
		font-family: monospace;
		font-size: 12px;
		color: hsl(var(--foreground));
	}

	.pane-command {
		font-size: 12px;
		color: hsl(var(--muted-foreground));
	}

	/* Compact mode adjustments */
	.compact .header {
		padding: 12px;
		padding-bottom: 8px;
	}

	.compact .header h1 {
		font-size: 16px;
	}

	.compact .count {
		padding: 6px 12px;
		font-size: 12px;
	}

	.compact .scroll-content {
		padding: 0 8px 8px;
	}

	.compact .project-header {
		padding: 8px 10px;
	}

	.compact .project-header .name {
		font-size: 13px;
	}

	.compact .project-sessions .session {
		padding: 10px 8px;
		gap: 8px;
	}

	.compact .session .state {
		width: 10px;
		height: 10px;
	}

	.compact .session .target {
		font-size: 13px;
	}

	.compact .session .action {
		font-size: 11px;
	}
</style>
