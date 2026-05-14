<script lang="ts">
	import { onMount } from 'svelte';
	import { serverStore } from '$lib/stores/servers.svelte';
	import * as Popover from '$lib/components/ui/popover';

	let open = $state(false);

	onMount(() => {
		serverStore.init();
	});

	function refresh() {
		void serverStore.refresh();
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="server-picker-trigger" aria-label="Switch server">
		<span class="dot"></span>
		<span class="hostname">{serverStore.current.hostname || 'claude-mux'}</span>
		<iconify-icon icon="mdi:chevron-down" class="chev"></iconify-icon>
	</Popover.Trigger>
	<Popover.Content class="server-picker-content" align="start" sideOffset={4}>
		<header class="picker-header">
			<span class="picker-title">Servers</span>
			<button
				class="refresh-btn"
				onclick={refresh}
				disabled={serverStore.loading}
				title="Refresh server list"
			>
				<iconify-icon
					icon="mdi:refresh"
					class:spin={serverStore.loading}
				></iconify-icon>
			</button>
		</header>
		{#if serverStore.error}
			<div class="error">{serverStore.error}</div>
		{/if}
		<ul class="server-list">
			{#each serverStore.servers as server (server.hostname)}
				{@const isCurrent = server.hostname === serverStore.current.hostname}
				<li>
					<a
						href="{server.url}/"
						class="server-item"
						class:active={isCurrent}
						aria-current={isCurrent ? 'page' : undefined}
					>
						<span class="dot" class:active={isCurrent}></span>
						<span class="hostname">{server.hostname}</span>
						{#if isCurrent}
							<iconify-icon icon="mdi:check" class="check"></iconify-icon>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	</Popover.Content>
</Popover.Root>

<style>
	:global(.server-picker-trigger) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border: 1px solid hsl(var(--border));
		border-radius: 6px;
		background: hsl(var(--secondary));
		color: hsl(var(--foreground));
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		min-width: 0;
	}

	:global(.server-picker-trigger:hover) {
		background: hsl(var(--accent));
	}

	:global(.server-picker-trigger .hostname) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 140px;
	}

	:global(.server-picker-trigger .dot) {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #27ae60;
		flex-shrink: 0;
	}

	:global(.server-picker-trigger .chev) {
		font-size: 14px;
		opacity: 0.6;
	}

	:global(.server-picker-content) {
		width: 220px;
		padding: 6px;
		z-index: 70;
	}

	.picker-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px 6px;
		border-bottom: 1px solid hsl(var(--border));
		margin-bottom: 4px;
	}

	.picker-title {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: hsl(var(--muted-foreground));
		font-weight: 600;
	}

	.refresh-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: hsl(var(--foreground));
		cursor: pointer;
		font-size: 14px;
	}

	.refresh-btn:hover:not(:disabled) {
		background: hsl(var(--accent));
	}

	.refresh-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.error {
		padding: 6px 8px;
		font-size: 12px;
		color: hsl(var(--destructive));
		background: color-mix(in oklch, hsl(var(--destructive)), transparent 88%);
		border-radius: 4px;
		margin-bottom: 4px;
	}

	.server-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.server-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-radius: 4px;
		text-decoration: none;
		color: hsl(var(--foreground));
		font-size: 13px;
	}

	.server-item:hover {
		background: hsl(var(--accent));
	}

	.server-item.active {
		background: color-mix(in oklch, hsl(var(--primary)), transparent 85%);
		font-weight: 500;
	}

	.server-item .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: hsl(var(--muted-foreground));
		flex-shrink: 0;
	}

	.server-item .dot.active {
		background: #27ae60;
	}

	.server-item .hostname {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.server-item .check {
		font-size: 14px;
		color: hsl(var(--primary));
	}
</style>
