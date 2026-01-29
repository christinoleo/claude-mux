<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { sessionStore, stateColor, getProjectColor, type Session } from '$lib/stores/sessions.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ScrollArea } from '$lib/components/ui/scroll-area';

	let showFolderBrowser = $state(false);
	let browserPath = $state('');
	let browserFolders = $state<{ name: string; path: string }[]>([]);
	let browserShowHidden = $state(false);
	let browserIsRoot = $state(false);
	let browserParent = $state<string | null>(null);

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

	onMount(() => {
		sessionStore.loadSavedProjects();
		// sessionStore.connect() is handled by the layout
	});

	async function sendKeys(target: string, keys: string) {
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys })
		});
	}

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
		}
	}

	async function openFolderBrowser() {
		showFolderBrowser = true;
		await browseTo('~');
	}

	let browserError = $state('');

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
</script>

<svelte:head>
	<title>claude-watch</title>
</svelte:head>

<div class="container">
	<header class="header">
		<h1>claude-watch</h1>
		<div class="header-actions">
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

	{#if flatProjects.length === 0}
		<div class="empty">No sessions yet. Click + to add a project.</div>
	{:else}
		{#each flatProjects as project}
			{@const color = getProjectColor(project.cwd)}
			{@const isNested = project.depth > 0}
			{@const firstSession = project.sessions[0]}
			<div class="project-group" class:nested={isNested} style="margin-left: {project.depth * 24}px; border-left-color: {color}">
				<div class="project-header">
					<div class="project-info">
						{#if isNested}
							<span class="nest-indicator">└</span>
						{/if}
						<span class="name">{getProjectName(project.cwd)}</span>
						<div class="meta">
							<Badge variant="secondary" class="text-xs">{project.sessions.length}</Badge>
							{#if firstSession?.git_root}<Badge variant="outline" class="border-orange-700 text-orange-400">git</Badge>{/if}
							{#if firstSession?.beads_enabled}<Badge variant="outline" class="border-purple-700 text-purple-400">beads</Badge>{/if}
						</div>
					</div>
					<div class="project-actions">
						<Button variant="ghost" size="icon-sm" onclick={() => newSessionInProject(project.cwd)} title="New Session">
							<iconify-icon icon="mdi:plus"></iconify-icon>
						</Button>
						<Button variant="ghost" size="icon-sm" class="hover:bg-red-900/50 hover:text-red-300" onclick={() => deleteProject(project.cwd)} title="Delete Project">
							<iconify-icon icon="mdi:delete"></iconify-icon>
						</Button>
					</div>
				</div>
				<div class="project-sessions">
					{#each project.sessions as session}
						{#if session.tmux_target}
							<a href="/session/{encodeURIComponent(session.tmux_target)}" class="session {session.state}">
								<span class="state" style="background: {stateColor(session.state)}"></span>
								<div class="session-info">
									<div class="target">{session.pane_title || session.tmux_target}</div>
									<div class="action">{session.current_action || session.state}</div>
								</div>
								<div class="actions">
									<Button
										variant="secondary"
										size="icon-sm"
										onclick={(e: MouseEvent) => { e.preventDefault(); sendKeys(session.tmux_target!, 'Escape'); }}
										title="Stop (Esc)"
									>
										<iconify-icon icon="mdi:stop"></iconify-icon>
									</Button>
									<Button
										variant="ghost-destructive"
										size="icon-sm"
										onclick={(e: MouseEvent) => { e.preventDefault(); killSession(session.id, session.pid, session.tmux_target); }}
										title="Kill"
									>
										<iconify-icon icon="mdi:power"></iconify-icon>
									</Button>
								</div>
							</a>
						{:else}
							<div class="session {session.state} no-tmux">
								<span class="state" style="background: {stateColor(session.state)}"></span>
								<div class="session-info">
									<div class="target">{session.id}</div>
									<div class="action">{session.current_action || session.state}</div>
									<div class="no-tmux-label">No tmux pane</div>
								</div>
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
							</div>
						{/if}
					{:else}
						<div class="empty-project">No active sessions</div>
					{/each}
				</div>
			</div>
		{/each}
	{/if}
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
	.container {
		padding: 16px;
		max-width: 800px;
		margin: 0 auto;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
		padding-bottom: 16px;
		border-bottom: 1px solid #44403c;
	}

	.header h1 {
		font-size: 24px;
		margin: 0;
	}

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.count {
		color: hsl(var(--muted-foreground));
		font-size: 14px;
		margin: 0 0 16px 0;
	}

	.empty {
		color: hsl(var(--muted-foreground));
		text-align: center;
		padding: 40px;
		font-size: 16px;
	}

	.project-group {
		margin-bottom: 20px;
		border-left: 4px solid;
		border-radius: 8px;
		overflow: hidden;
	}

	.project-group.nested {
		margin-bottom: 12px;
		margin-top: -8px;
	}

	.project-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 14px;
		background: #292524;
	}

	.project-info {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.nest-indicator {
		font-family: monospace;
		color: hsl(var(--muted-foreground));
		margin-right: -4px;
	}

	.project-header .name {
		font-weight: 600;
		font-size: 15px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-header .meta {
		display: flex;
		align-items: center;
		gap: 6px;
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
		gap: 12px;
		padding: 16px;
		padding-left: 12px;
		background: #111;
		border-top: 1px solid #222;
		text-decoration: none;
		color: inherit;
		transition: background 0.15s;
	}

	.project-sessions .session:hover {
		background: #1a1a1a;
	}

	.session .state {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.session-info {
		flex: 1;
		min-width: 0;
	}

	.session .target {
		font-weight: 600;
		font-size: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session .action {
		color: hsl(var(--muted-foreground));
		font-size: 14px;
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
		font-size: 12px;
		font-style: italic;
	}

	.empty-project {
		padding: 16px;
		background: #111;
		color: hsl(var(--muted-foreground));
		text-align: center;
		border-radius: 0 0 8px 8px;
	}

	.actions {
		display: flex;
		gap: 6px;
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
</style>
