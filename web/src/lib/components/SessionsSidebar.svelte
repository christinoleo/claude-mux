<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { sessionStore, stateColor } from '$lib/stores/sessions.svelte';
	import { inputInjection } from '$lib/stores/input-injection.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import BeadsPanel from './BeadsPanel.svelte';
	import ScreenshotsPanel from './ScreenshotsPanel.svelte';
	import type { BeadsIssue } from '$lib/stores/beads.svelte';

	interface Props {
		onSelect?: () => void;
		hideSessionsList?: boolean;
	}

	let { onSelect, hideSessionsList = false }: Props = $props();

	let sessionsExpanded = $state(true);

	function toggleSessionsExpanded() {
		sessionsExpanded = !sessionsExpanded;
	}

	// Check if we're in a session view
	const isSessionView = $derived($page.url.pathname.startsWith('/session/'));

	const currentTarget = $derived(
		$page.params.target ? decodeURIComponent($page.params.target) : null
	);

	const currentSession = $derived(
		sessionStore.sessions.find((s) => s.tmux_target === currentTarget || s.id === currentTarget)
	);

	// Extract project name from cwd (last folder in path)
	const projectName = $derived.by(() => {
		const cwd = currentSession?.cwd || currentSession?.git_root;
		if (!cwd) return null;
		const parts = cwd.split('/').filter(Boolean);
		return parts[parts.length - 1] || null;
	});

	// Filter sessions to only show those from the same project
	const projectSessions = $derived.by(() => {
		const projectRoot = currentSession?.git_root || currentSession?.cwd;
		if (!projectRoot) return sessionStore.sessions;
		return sessionStore.sessions.filter(
			(s) => s.git_root === projectRoot || s.cwd === projectRoot
		);
	});

	async function newSession() {
		const cwd = currentSession?.cwd || currentSession?.git_root;
		if (!cwd) return;

		const res = await fetch('/api/projects/new-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd })
		});
		const data = await res.json();
		if (data.ok && data.session) {
			const tmuxTarget = data.session + ':1.1';
			onSelect?.();
			goto(`/session/${encodeURIComponent(tmuxTarget)}`);
		}
	}

	function handleIssueSelect(issue: BeadsIssue) {
		if (isSessionView) {
			// In session view: inject ID into input
			inputInjection.inject(issue.id);
			onSelect?.(); // Close drawer on mobile
		}
		// On main page: just view (future: show details)
	}
</script>

<nav class="sidebar-sessions">
	<div class="sidebar-header">
		<a href="/" class="home-link" onclick={onSelect}>
			<iconify-icon icon="mdi:folder-outline"></iconify-icon>
			<span>{projectName || 'Sessions'}</span>
		</a>
		{#if currentSession?.cwd}
			<Button variant="ghost" size="icon-sm" onclick={newSession} title="New session in this project" class="new-session-btn">
				<iconify-icon icon="mdi:plus"></iconify-icon>
			</Button>
		{/if}
	</div>

	<div class="scroll-content">
		{#if !hideSessionsList}
			<div class="sessions-panel">
				<button class="panel-header" onclick={toggleSessionsExpanded} type="button">
					<iconify-icon icon="mdi:console"></iconify-icon>
					<span>Sessions</span>
					<Badge variant="outline" class="ml-auto session-count">{projectSessions.length}</Badge>
					<iconify-icon
						icon={sessionsExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'}
						class="chevron"
					></iconify-icon>
				</button>

				{#if sessionsExpanded}
					<div class="sessions-list">
						{#each projectSessions as session (session.id)}
							{#if session.tmux_target}
								<a
									href="/session/{encodeURIComponent(session.tmux_target)}"
									class="session-item"
									class:active={session.tmux_target === currentTarget || session.id === currentTarget}
									onclick={onSelect}
								>
									<span class="icon-slot">
										<span class="state-dot" style="background: {stateColor(session.state)}"></span>
									</span>
									<div class="session-info">
										<div class="session-name">{session.pane_title || session.tmux_target}</div>
										{#if session.current_action}
											<div class="session-action">{session.current_action}</div>
										{/if}
									</div>
								</a>
							{/if}
						{:else}
							<div class="empty">No active sessions</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Beads Issues Panel -->
		{#if currentSession?.beads_enabled}
			<BeadsPanel
				project={currentSession.git_root}
				onSelect={handleIssueSelect}
			/>
		{/if}

		<!-- Screenshots Panel -->
		{#if currentSession?.screenshots && currentSession.screenshots.length > 0}
			<ScreenshotsPanel
				sessionId={currentSession.id}
				screenshots={currentSession.screenshots}
			/>
		{/if}
	</div>
</nav>

<style>
	.sidebar-sessions {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: hsl(var(--card));
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px;
		border-bottom: 1px solid hsl(var(--border));
	}

	.home-link {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		color: hsl(var(--foreground));
		text-decoration: none;
		font-weight: 600;
		font-size: 14px;
		padding: 8px 12px;
		border-radius: 8px;
		background: hsl(var(--secondary));
	}

	.home-link:hover {
		background: hsl(var(--accent));
	}

	.new-session-btn {
		flex-shrink: 0;
	}

	.scroll-content {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 12px;
		border: none;
		background: transparent;
		color: inherit;
		font-family: inherit;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
	}

	.panel-header:hover {
		background: hsl(var(--accent) / 0.5);
	}

	.panel-header :global(.session-count) {
		font-size: 11px;
		padding: 2px 6px;
	}

	.chevron {
		font-size: 18px;
		color: hsl(var(--muted-foreground));
	}

	.sessions-list {
		padding: 0 12px 12px;
	}

	.session-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 8px 12px;
		border-radius: 8px;
		text-decoration: none;
		color: inherit;
		margin-bottom: 4px;
		position: relative;
	}

	.session-item:hover {
		background: hsl(var(--accent));
	}

	.session-item.active {
		background: color-mix(in oklch, var(--primary), transparent 75%);
		box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary), transparent 70%);
	}

	.session-item.active::before {
		content: '';
		position: absolute;
		left: 0;
		top: 4px;
		bottom: 4px;
		width: 4px;
		background: var(--primary);
		border-radius: 0 2px 2px 0;
	}

	.session-item.active .session-name {
		color: var(--primary);
	}

	.icon-slot {
		width: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		align-self: center;
	}

	.state-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}

	.session-info {
		flex: 1;
		min-width: 0;
	}

	.session-name {
		font-size: 13px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-action {
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-top: 2px;
	}

	.empty {
		color: hsl(var(--muted-foreground));
		text-align: center;
		padding: 20px;
		font-size: 13px;
	}
</style>
