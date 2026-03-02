<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import SidebarAccordion from './SidebarAccordion.svelte';
	import type { Screenshot } from '$lib/stores/sessions.svelte';

	interface Props {
		sessionId: string;
		screenshots: Screenshot[];
	}

	let { sessionId, screenshots }: Props = $props();

	let viewingScreenshot = $state<string | null>(null);

	// Swipe tracking
	let touchStartX = $state(0);
	let touchCurrentX = $state(0);
	let isSwiping = $state(false);

	async function dismissScreenshot(path: string) {
		await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/screenshots?path=${encodeURIComponent(path)}`, {
			method: 'DELETE'
		});
		if (viewingScreenshot === path) {
			viewingScreenshot = null;
		}
	}

	function openModal(path: string) {
		viewingScreenshot = path;
	}

	function closeModal() {
		viewingScreenshot = null;
		resetSwipe();
	}

	function getFilename(path: string): string {
		return path.split('/').pop() || path;
	}

	function handleTouchStart(e: TouchEvent) {
		touchStartX = e.touches[0].clientX;
		touchCurrentX = touchStartX;
		isSwiping = true;
	}

	function handleTouchMove(e: TouchEvent) {
		if (!isSwiping) return;
		touchCurrentX = e.touches[0].clientX;
	}

	function handleTouchEnd() {
		if (!isSwiping) return;
		const deltaX = touchCurrentX - touchStartX;
		if (deltaX < -100) {
			closeModal();
		}
		resetSwipe();
	}

	function resetSwipe() {
		isSwiping = false;
		touchStartX = 0;
		touchCurrentX = 0;
	}

	const swipeOffset = $derived(isSwiping ? Math.min(0, touchCurrentX - touchStartX) : 0);
</script>

<SidebarAccordion
	icon="mdi:image-multiple"
	title="Screenshots"
	count={screenshots.length}
	defaultExpanded
>
	{#if screenshots.length === 0}
		<p class="empty">No screenshots</p>
	{:else}
		<div class="screenshots-grid">
			{#each screenshots as screenshot, i (screenshot.path + ':' + i)}
				<div class="screenshot-item">
					<button
						class="thumbnail"
						onclick={() => openModal(screenshot.path)}
						title={getFilename(screenshot.path)}
					>
						<img
							src="/api/files/image?path={encodeURIComponent(screenshot.path)}"
							alt={getFilename(screenshot.path)}
							loading="lazy"
						/>
					</button>
					<Button
						variant="ghost"
						size="icon-sm"
						class="dismiss-btn"
						onclick={() => dismissScreenshot(screenshot.path)}
						title="Dismiss screenshot"
					>
						<iconify-icon icon="mdi:close"></iconify-icon>
					</Button>
				</div>
			{/each}
		</div>
	{/if}
</SidebarAccordion>

<!-- Fullscreen Modal -->
{#if viewingScreenshot}
	<div
		class="modal-overlay"
		onclick={closeModal}
		onkeydown={(e) => e.key === 'Escape' && closeModal()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content"
			style="transform: translateX({swipeOffset}px)"
			onclick={(e) => e.stopPropagation()}
			ontouchstart={handleTouchStart}
			ontouchmove={handleTouchMove}
			ontouchend={handleTouchEnd}
			role="document"
		>
			<img
				src="/api/files/image?path={encodeURIComponent(viewingScreenshot)}"
				alt={getFilename(viewingScreenshot)}
				class="modal-image"
			/>

			<div class="modal-actions">
				<Button
					variant="secondary"
					size="sm"
					onclick={closeModal}
					class="modal-btn"
				>
					<iconify-icon icon="mdi:close"></iconify-icon>
					<span>Close</span>
				</Button>
				<Button
					variant="destructive"
					size="sm"
					onclick={() => dismissScreenshot(viewingScreenshot!)}
					class="modal-btn"
				>
					<iconify-icon icon="mdi:delete"></iconify-icon>
					<span>Delete</span>
				</Button>
			</div>

			<div class="swipe-hint">
				<iconify-icon icon="mdi:gesture-swipe-left"></iconify-icon>
				<span>Swipe left to close</span>
			</div>
		</div>
	</div>
{/if}

<style>
	.screenshots-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 4px;
	}

	.screenshot-item {
		position: relative;
		aspect-ratio: 16 / 10;
		border-radius: 4px;
		overflow: hidden;
		background: hsl(var(--muted));
	}

	.thumbnail {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.thumbnail img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.thumbnail:hover {
		opacity: 0.9;
	}

	.screenshot-item :global(.dismiss-btn) {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 24px;
		height: 24px;
		background: hsl(var(--background) / 0.8);
		border-radius: 4px;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.screenshot-item:hover :global(.dismiss-btn) {
		opacity: 1;
	}

	.screenshot-item :global(.dismiss-btn:hover) {
		background: hsl(var(--destructive));
		color: hsl(var(--destructive-foreground));
	}

	.empty {
		color: hsl(var(--muted-foreground));
		font-size: 11px;
		margin: 0;
	}

	/* Modal styles */
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: rgba(0, 0, 0, 0.9);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}

	.modal-content {
		position: relative;
		max-width: 100%;
		max-height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		transition: transform 0.1s ease-out;
	}

	.modal-image {
		max-width: 100%;
		max-height: calc(100vh - 120px);
		object-fit: contain;
		border-radius: 8px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
	}

	.modal-actions {
		display: flex;
		gap: 12px;
	}

	.modal-actions :global(.modal-btn) {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.swipe-hint {
		display: none;
		align-items: center;
		gap: 6px;
		color: hsl(var(--muted-foreground));
		font-size: 12px;
	}

	@media (max-width: 768px) {
		.swipe-hint {
			display: flex;
		}
	}
</style>
