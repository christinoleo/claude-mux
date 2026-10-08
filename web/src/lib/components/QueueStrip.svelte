<script lang="ts">
	/**
	 * Everything waiting to reach the agent, in one place, attached to the top
	 * edge of the composer: claude-mux's own queue first (it can be reordered,
	 * edited, steered into the running turn, or dropped), then what sits in
	 * Claude Code's in-pane queue, which only Claude Code can reorder and which
	 * offers the one action it has — send now.
	 *
	 * The layout follows t3code's QueuedRunsControl
	 * (https://github.com/pingdotgg/t3code, apps/web/src/components/chat/QueuedRunsControl.tsx,
	 * MIT, © T3 Tools Inc.), adapted to a server-held queue.
	 */
	import * as Collapsible from '$lib/components/ui/collapsible';
	import type { QueuedMessageInfo } from '$shared/types/ws-messages.js';
	import { imageMimeFor } from '$shared/utils/image-types.js';

	let {
		target,
		sessionId = null,
		queue,
		paneQueue = [],
		busy = false,
		editingId = null,
		onEdit
	}: {
		target: string;
		/** Attachments are stored per session id, which the thumbnails are fetched by. */
		sessionId?: string | null;
		queue: QueuedMessageInfo[];
		/** Messages typed into Claude Code's own queue, read off the pane. */
		paneQueue?: string[];
		/** A turn is running, so a steer or send-now has somewhere to go. */
		busy?: boolean;
		/** The item the composer is editing, drawn as such. */
		editingId?: string | null;
		onEdit: (item: QueuedMessageInfo) => void;
	} = $props();

	let open = $state(true);
	let error = $state<string | null>(null);
	/** The item being dragged by its grip, and the slot it would land in. */
	let drag = $state<{ id: string; from: number; to: number } | null>(null);
	let listEl: HTMLElement | null = $state(null);
	/** The rows' vertical midpoints, measured once when a drag starts. */
	let midpoints: number[] = [];

	const total = $derived(queue.length + paneQueue.length);
	const base = $derived(`/api/sessions/${encodeURIComponent(target)}`);

	async function call(path: string, method: string, body?: object): Promise<void> {
		error = null;
		const res = await fetch(`${base}/${path}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body ? JSON.stringify(body) : undefined
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			error = data.error ?? res.statusText;
		}
	}

	const remove = (index: number) => call('queue', 'DELETE', { index });
	const move = (fromIndex: number, toIndex: number) => {
		if (toIndex < 0 || toIndex >= queue.length || toIndex === fromIndex) return;
		void call('queue', 'PATCH', { fromIndex, toIndex });
	};
	const steer = (id: string) => call('steer', 'POST', { id });
	const sendNow = () => call('send-now', 'POST');

	function onGripKey(e: KeyboardEvent, index: number) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			move(index, index + (e.key === 'ArrowUp' ? -1 : 1));
		}
	}

	/** The slot a pointer at this height falls into: the last row whose midpoint it is past. */
	function slotAt(y: number): number {
		let slot = 0;
		for (const [i, mid] of midpoints.entries()) if (y > mid) slot = i;
		return slot;
	}

	function onGripDown(e: PointerEvent, item: QueuedMessageInfo, index: number) {
		if (e.button !== 0) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const rows = listEl ? Array.from(listEl.querySelectorAll<HTMLElement>('[data-queue-row]')) : [];
		midpoints = rows.map((row) => {
			const r = row.getBoundingClientRect();
			return r.top + r.height / 2;
		});
		drag = { id: item.id, from: index, to: index };
	}
	function onGripMove(e: PointerEvent) {
		if (drag) drag.to = slotAt(e.clientY);
	}
	function onGripUp() {
		if (!drag) return;
		const { from, to } = drag;
		drag = null;
		move(from, to);
	}

	const fileName = (path: string) => path.split('/').pop() ?? path;
	const thumbUrl = (id: string, path: string) =>
		`/api/sessions/${encodeURIComponent(id)}/attach?path=${encodeURIComponent(path)}`;
</script>

{#if total > 0}
	<Collapsible.Root bind:open class="qs">
		<div class="qs-head">
			<Collapsible.Trigger class="qs-toggle">
				<iconify-icon icon={open ? 'mdi:chevron-down' : 'mdi:chevron-right'}></iconify-icon>
				Queued ({total})
			</Collapsible.Trigger>
			{#if error}<span class="qs-error" role="alert">{error}</span>{/if}
		</div>
		<Collapsible.Content>
			<ul class="qs-list" bind:this={listEl}>
				{#each queue as item, i (item.id)}
					{@const dropHere = drag && drag.id !== item.id && drag.to === i}
					<li
						class="qs-row"
						data-queue-row
						class:editing={item.id === editingId}
						class:dragging={drag?.id === item.id}
						class:drop-above={dropHere && drag!.from > i}
						class:drop-below={dropHere && drag!.from < i}
					>
						<button
							type="button"
							class="qs-grip"
							title="Drag, or use the arrow keys, to reorder"
							aria-label={`Reorder message ${i + 1} of ${queue.length}`}
							disabled={queue.length < 2}
							onkeydown={(e) => onGripKey(e, i)}
							onpointerdown={(e) => onGripDown(e, item, i)}
							onpointermove={onGripMove}
							onpointerup={onGripUp}
							onpointercancel={() => (drag = null)}
						>
							<iconify-icon icon="mdi:drag-vertical"></iconify-icon>
						</button>
						<div class="qs-body">
							{#if item.attachments?.length}
								<div class="qs-thumbs">
									{#each item.attachments as path (path)}
										{#if imageMimeFor(path) && sessionId}
											<img class="qs-thumb" src={thumbUrl(sessionId, path)} alt={fileName(path)} title={fileName(path)} />
										{:else}
											<span class="qs-thumb qs-file" title={fileName(path)}>
												<iconify-icon icon="mdi:file-outline"></iconify-icon>
											</span>
										{/if}
									{/each}
								</div>
							{/if}
							<p class="qs-text">
								{#if item.kind === 'control'}<span class="qs-tag">dashboard</span>{/if}
								{#if item.id === editingId}<span class="qs-tag edit">editing</span>{/if}
								{item.text}
							</p>
						</div>
						<div class="qs-actions">
							{#if item.kind === 'user'}
								<button
									type="button"
									class="qs-btn"
									title="Edit in the composer"
									aria-label="Edit"
									onclick={() => onEdit(item)}
								>
									<iconify-icon icon="mdi:pencil-outline"></iconify-icon>
								</button>
								{#if busy}
									<button
										type="button"
										class="qs-btn"
										title="Steer: make Claude read this now"
										aria-label="Steer"
										onclick={() => void steer(item.id)}
									>
										<iconify-icon icon="mdi:arrow-right-top"></iconify-icon>
									</button>
								{/if}
							{/if}
							<button
								type="button"
								class="qs-btn qs-remove"
								title="Remove from the queue"
								aria-label="Remove"
								onclick={() => void remove(i)}
							>
								<iconify-icon icon="mdi:close"></iconify-icon>
							</button>
						</div>
					</li>
				{/each}
				{#each paneQueue as text, i (i + text)}
					<li class="qs-row in-pane">
						<span class="qs-grip" aria-hidden="true">
							<iconify-icon icon="mdi:console-line"></iconify-icon>
						</span>
						<div class="qs-body">
							<p class="qs-text"><span class="qs-tag">in Claude's queue</span>{text}</p>
						</div>
						{#if busy && i === 0}
							<!-- Claude Code hands its whole queue over at once, so the
							     action sits on the first row and covers them all. -->
							<div class="qs-actions">
								<button
									type="button"
									class="qs-btn qs-wide"
									title="Hand Claude's queue to the running turn now"
									onclick={() => void sendNow()}
								>
									<iconify-icon icon="mdi:send-clock-outline"></iconify-icon>Send now
								</button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</Collapsible.Content>
	</Collapsible.Root>
{/if}

<style>
	/* A shelf on the composer's top edge: narrower than the card, the same
	   surface, so it reads as part of the composer rather than the transcript. */
	:global(.qs) {
		margin: 0 14px;
		background: #1a1a1b;
		border: 1px solid #2a2a2c;
		border-bottom: 0;
		border-radius: 12px 12px 0 0;
		padding: 4px 6px 6px;
		animation: shelf-in 140ms ease-out;
	}
	@media (min-width: 900px) {
		:global(.qs) {
			width: calc(100% - 28px);
			max-width: calc(62rem - 28px);
			margin: 0 auto;
		}
	}

	.qs-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 26px;
	}
	:global(.qs-toggle) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 6px 2px 2px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #a8a29e;
		font-size: 12px;
		cursor: pointer;
	}
	:global(.qs-toggle:hover) {
		color: #e7e5e4;
	}
	:global(.qs-toggle:focus-visible) {
		outline: 2px solid #f59e0b;
		outline-offset: 1px;
	}
	.qs-error {
		color: #f87171;
		font-size: 11px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.qs-list {
		list-style: none;
		margin: 2px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 30vh;
		overflow-y: auto;
	}
	.qs-row {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		padding: 4px 4px 4px 0;
		border-radius: 8px;
		border-top: 2px solid transparent;
		border-bottom: 2px solid transparent;
	}
	.qs-row:hover {
		background: #222224;
	}
	.qs-row.editing {
		background: #1f2a22;
	}
	.qs-row.dragging {
		opacity: 0.5;
	}
	.qs-row.drop-above {
		border-top-color: #57534e;
	}
	.qs-row.drop-below {
		border-bottom-color: #57534e;
	}
	.qs-row.in-pane .qs-text {
		color: #8a8580;
	}

	.qs-grip {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 28px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #57534e;
		font-size: 16px;
		cursor: grab;
		touch-action: none;
	}
	.qs-grip:disabled {
		cursor: default;
	}
	.qs-grip:focus-visible {
		outline: 2px solid #f59e0b;
		color: #e7e5e4;
	}
	.qs-row.in-pane .qs-grip {
		cursor: default;
		font-size: 13px;
	}

	.qs-body {
		flex: 1;
		min-width: 0;
		padding-top: 5px;
	}
	.qs-text {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.45;
		color: #d6d3d1;
		white-space: pre-wrap;
		word-break: break-word;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.qs-tag {
		margin-right: 6px;
		padding: 0 5px;
		border-radius: 4px;
		background: #2a2a2c;
		color: #a8a29e;
		font-size: 10.5px;
	}
	.qs-tag.edit {
		background: #14532d;
		color: #d6f5e0;
	}

	.qs-thumbs {
		display: flex;
		gap: 4px;
		margin-bottom: 4px;
	}
	.qs-thumb {
		width: 32px;
		height: 32px;
		border-radius: 5px;
		object-fit: cover;
		background: #2a2a2c;
	}
	.qs-file {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: #a8a29e;
	}

	.qs-actions {
		flex: none;
		display: flex;
		gap: 2px;
	}
	.qs-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-width: 30px;
		height: 28px;
		padding: 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #a8a29e;
		font-size: 15px;
		cursor: pointer;
	}
	.qs-btn:hover {
		background: #2e2926;
		color: #e7e5e4;
	}
	.qs-btn:focus-visible {
		outline: 2px solid #f59e0b;
		outline-offset: 1px;
	}
	.qs-remove:hover {
		background: #3a1a1a;
		color: #f87171;
	}
	.qs-wide {
		font-size: 12px;
	}
	.qs-wide iconify-icon {
		font-size: 15px;
	}

	@keyframes shelf-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.qs) {
			animation: none;
		}
	}
</style>
