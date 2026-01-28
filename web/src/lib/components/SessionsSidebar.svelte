<script lang="ts">
	import { page } from '$app/stores';
	import { sessionStore, stateColor } from '$lib/stores/sessions.svelte';

	interface Props {
		onSelect?: () => void;
	}

	let { onSelect }: Props = $props();

	const currentTarget = $derived(
		$page.params.target ? decodeURIComponent($page.params.target) : null
	);
</script>

<nav class="sidebar-sessions">
	<div class="sidebar-header">
		<a href="/" class="home-link" onclick={onSelect}>
			<iconify-icon icon="mdi:view-dashboard"></iconify-icon>
			<span>Sessions</span>
			<span class="count">{sessionStore.sessions.length}</span>
		</a>
	</div>

	<div class="sessions-list">
		{#each sessionStore.sessions as session (session.id)}
			{#if session.tmux_target}
				<a
					href="/session/{encodeURIComponent(session.tmux_target)}"
					class="session-item"
					class:active={session.tmux_target === currentTarget || session.id === currentTarget}
					onclick={onSelect}
				>
					<span class="state-dot" style="background: {stateColor(session.state)}"></span>
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
</nav>

<style>
	.sidebar-sessions {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #111;
	}

	.sidebar-header {
		padding: 12px;
		border-bottom: 1px solid #222;
	}

	.home-link {
		display: flex;
		align-items: center;
		gap: 8px;
		color: #fff;
		text-decoration: none;
		font-weight: 600;
		font-size: 14px;
		padding: 8px 12px;
		border-radius: 8px;
		background: #1a1a1a;
	}

	.home-link:hover {
		background: #222;
	}

	.home-link .count {
		margin-left: auto;
		background: #333;
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 12px;
		font-weight: 500;
	}

	.sessions-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
	}

	.session-item {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border-radius: 8px;
		text-decoration: none;
		color: inherit;
		margin-bottom: 4px;
	}

	.session-item:hover {
		background: #1a1a1a;
	}

	.session-item.active {
		background: #1a1a1a;
		border-left: 3px solid #27ae60;
		padding-left: 9px;
	}

	.state-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 4px;
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
		color: #666;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-top: 2px;
	}

	.empty {
		color: #555;
		text-align: center;
		padding: 20px;
		font-size: 13px;
	}
</style>
