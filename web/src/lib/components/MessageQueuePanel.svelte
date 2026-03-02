<script lang="ts">
	import SidebarAccordion from './SidebarAccordion.svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';

	interface QueuedMessage {
		text: string;
		queuedAt: number;
	}

	interface Props {
		target: string;
	}

	let { target }: Props = $props();

	let queue = $state<QueuedMessage[]>([]);
	let loading = $state(false);

	const currentSession = $derived(sessionStore.sessionByTarget.get(target));
	const queueCount = $derived(currentSession?.queue_count ?? 0);

	// Re-fetch queue when count changes
	$effect(() => {
		// Track queueCount to trigger re-fetch
		if (queueCount >= 0) {
			fetchQueue();
		}
	});

	async function fetchQueue() {
		loading = true;
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(target)}/queue`);
			const data = await res.json();
			queue = data.queue ?? [];
		} catch {
			queue = [];
		} finally {
			loading = false;
		}
	}

	async function removeItem(index: number) {
		const res = await fetch(`/api/sessions/${encodeURIComponent(target)}/queue`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index })
		});
		const data = await res.json();
		queue = data.queue ?? [];
	}

	async function clearAll() {
		await fetch(`/api/sessions/${encodeURIComponent(target)}/queue`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({})
		});
		queue = [];
	}

	async function moveItem(fromIndex: number, toIndex: number) {
		const res = await fetch(`/api/sessions/${encodeURIComponent(target)}/queue`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ fromIndex, toIndex })
		});
		const data = await res.json();
		queue = data.queue ?? [];
	}

	function relativeTime(ts: number): string {
		const diff = Math.floor((Date.now() - ts) / 1000);
		if (diff < 60) return `${diff}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		return `${Math.floor(diff / 3600)}h ago`;
	}

	function truncate(text: string, maxLen = 80): string {
		return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
	}
</script>

<SidebarAccordion icon="mdi:tray-full" title="Queue" count={queueCount}>
	{#if loading && queue.length === 0}
		<p class="empty-text">Loading...</p>
	{:else if queue.length === 0}
		<p class="empty-text">No queued messages</p>
	{:else}
		<div class="queue-list">
			{#each queue as item, i (item.queuedAt)}
				<div class="queue-item">
					<div class="queue-item-content">
						<span class="queue-text">{truncate(item.text)}</span>
						<span class="queue-time">{relativeTime(item.queuedAt)}</span>
					</div>
					<div class="queue-item-actions">
						<button
							class="queue-btn"
							onclick={() => moveItem(i, i - 1)}
							disabled={i === 0}
							title="Move up"
						>
							<iconify-icon icon="mdi:arrow-up" style="font-size: 12px;"></iconify-icon>
						</button>
						<button
							class="queue-btn"
							onclick={() => moveItem(i, i + 1)}
							disabled={i === queue.length - 1}
							title="Move down"
						>
							<iconify-icon icon="mdi:arrow-down" style="font-size: 12px;"></iconify-icon>
						</button>
						<button
							class="queue-btn queue-btn-delete"
							onclick={() => removeItem(i)}
							title="Remove"
						>
							<iconify-icon icon="mdi:close" style="font-size: 12px;"></iconify-icon>
						</button>
					</div>
				</div>
			{/each}
		</div>
		{#if queue.length >= 2}
			<button class="clear-all" onclick={clearAll}>Clear all</button>
		{/if}
	{/if}
</SidebarAccordion>

<style>
	.empty-text {
		color: hsl(var(--muted-foreground));
		font-size: 11px;
		margin: 0;
	}

	.queue-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.queue-item {
		display: flex;
		align-items: flex-start;
		gap: 3px;
		padding: 4px 6px;
		background: #1a1a1a;
		border-radius: 4px;
		border: 1px solid #2a2a2a;
	}

	.queue-item-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.queue-text {
		font-size: 11px;
		color: #ccc;
		word-break: break-word;
		line-height: 1.3;
	}

	.queue-time {
		font-size: 9px;
		color: #666;
	}

	.queue-item-actions {
		display: flex;
		gap: 1px;
		flex-shrink: 0;
	}

	.queue-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border: none;
		border-radius: 3px;
		background: transparent;
		color: #888;
		cursor: pointer;
		padding: 0;
	}

	.queue-btn:hover:not(:disabled) {
		background: #333;
		color: #ccc;
	}

	.queue-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.queue-btn-delete:hover:not(:disabled) {
		background: #3a1a1a;
		color: #e74c3c;
	}

	.clear-all {
		display: block;
		width: 100%;
		margin-top: 4px;
		padding: 3px;
		border: none;
		border-radius: 3px;
		background: transparent;
		color: #888;
		font-size: 10px;
		cursor: pointer;
		text-align: center;
	}

	.clear-all:hover {
		background: #3a1a1a;
		color: #e74c3c;
	}
</style>
