<script lang="ts">
	import { page } from '$app/stores';
	import { sessionStore, stateColor } from '$lib/stores/sessions.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';

	interface Props {
		onSelect?: () => void;
	}

	let { onSelect }: Props = $props();

	const currentTarget = $derived(
		$page.params.target ? decodeURIComponent($page.params.target) : null
	);

	const currentSession = $derived(
		sessionStore.sessions.find((s) => s.tmux_target === currentTarget || s.id === currentTarget)
	);

	// Extract project name from cwd (last folder in path)
	const projectName = $derived(() => {
		const cwd = currentSession?.cwd || currentSession?.git_root;
		if (!cwd) return null;
		const parts = cwd.split('/').filter(Boolean);
		return parts[parts.length - 1] || null;
	});
</script>

<nav class="sidebar-sessions">
	<div class="sidebar-header">
		<a href="/" class="home-link" onclick={onSelect}>
			<iconify-icon icon="mdi:folder-outline"></iconify-icon>
			<span>{projectName() || 'Sessions'}</span>
			<Badge variant="secondary" class="ml-auto">{sessionStore.sessions.length}</Badge>
		</a>
	</div>

	<ScrollArea class="flex-1">
		<div class="sessions-list">
			{#each sessionStore.sessions as session (session.id)}
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
	</ScrollArea>
</nav>

<style>
	.sidebar-sessions {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: hsl(var(--card));
	}

	.sidebar-header {
		padding: 12px;
		border-bottom: 1px solid hsl(var(--border));
	}

	.home-link {
		display: flex;
		align-items: center;
		gap: 8px;
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

	.sessions-list {
		padding: 8px 12px;
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
	}

	.session-item:hover {
		background: hsl(var(--accent));
	}

	.session-item.active {
		background: hsl(var(--accent));
		border-left: 3px solid hsl(var(--primary));
		padding-left: 9px;
	}

	.icon-slot {
		width: 18px;
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
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
