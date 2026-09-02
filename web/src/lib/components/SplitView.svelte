<script lang="ts">
	/**
	 * Two session pages side by side, each in an iframe on its own host.
	 *
	 * The page inside a pane draws its own composer, and that composer carries
	 * the pane's controls — swap, zoom, close — so this component draws nothing
	 * but the two frames and the divider. The frame asks for those actions with
	 * postMessage; this side answers only with whether the frame has focus.
	 * Dropping a sidebar row on a pane replaces what the pane shows.
	 */
	import { onMount } from 'svelte';
	import { splitStore, type PaneSide, MIN_PANE_PX } from '$lib/stores/split.svelte';
	import { serverStore } from '$lib/stores/servers.svelte';
	import { paneUrl, parseRef, type PaneRef } from '$lib/split-refs';

	let { a, b }: { a: PaneRef; b: PaneRef } = $props();

	let frameA = $state<HTMLIFrameElement | null>(null);
	let frameB = $state<HTMLIFrameElement | null>(null);
	let root = $state<HTMLElement | null>(null);

	const urlA = $derived(paneUrl(a, serverStore.servers, serverStore.self));
	const urlB = $derived(paneUrl(b, serverStore.servers, serverStore.self));

	/** Grid columns from the ratio, unless a pane is zoomed. */
	const columns = $derived.by(() => {
		if (splitStore.zoom === 'a') return '1fr 0 0';
		if (splitStore.zoom === 'b') return '0 0 1fr';
		const pct = Math.round(splitStore.ratio * 1000) / 10;
		return `${pct}fr 6px ${100 - pct}fr`;
	});

	function frameOf(side: PaneSide): HTMLIFrameElement | null {
		return side === 'a' ? frameA : frameB;
	}

	function sideOf(source: MessageEventSource | null): PaneSide | null {
		if (source && frameA?.contentWindow === source) return 'a';
		if (source && frameB?.contentWindow === source) return 'b';
		return null;
	}

	/** Tell each frame whether it holds the focus. */
	function announceFocus() {
		for (const side of ['a', 'b'] as PaneSide[]) {
			const ref = side === 'a' ? a : b;
			frameOf(side)?.contentWindow?.postMessage(
				{ type: 'claude-mux:focus', focused: splitStore.focus === side, side, local: ref.host === null },
				'*'
			);
		}
	}

	$effect(() => {
		void splitStore.focus;
		announceFocus();
	});

	function onMessage(e: MessageEvent) {
		const side = sideOf(e.source);
		if (!side) return;
		const msg = e.data as { type?: string; action?: string; side?: string } | null;
		if (!msg || msg.type !== 'claude-mux:pane') return;
		switch (msg.action) {
			case 'focus':
				splitStore.setFocus(side);
				break;
			case 'focus-other':
				splitStore.setFocus(splitStore.other(side));
				break;
			case 'swap':
				splitStore.swap();
				break;
			case 'zoom':
				splitStore.toggleZoom(side);
				break;
			case 'close':
				splitStore.close(side);
				break;
			case 'ready':
				announceFocus();
				break;
		}
	}

	// ── divider ──────────────────────────────────────────────────────────────
	let resizing = $state(false);
	function startResize(e: PointerEvent) {
		if (splitStore.zoom) return;
		resizing = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function moveResize(e: PointerEvent) {
		if (!resizing || !root) return;
		const rect = root.getBoundingClientRect();
		const min = MIN_PANE_PX / rect.width;
		splitStore.setRatio(Math.min(1 - min, Math.max(min, (e.clientX - rect.left) / rect.width)));
	}
	function endResize() {
		resizing = false;
	}

	// ── drop targets ─────────────────────────────────────────────────────────
	function onDrop(side: PaneSide, e: DragEvent) {
		e.preventDefault();
		const text = e.dataTransfer?.getData('text/claude-mux-session') ?? '';
		const ref = parseRef(text);
		splitStore.dragging = false;
		if (ref) splitStore.openIn(side, ref, null);
	}

	onMount(() => {
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});
</script>

<div
	class="split"
	class:resizing
	class:dragging={splitStore.dragging}
	style="grid-template-columns: {columns}"
	bind:this={root}
>
	{#snippet pane(side: PaneSide, ref: PaneRef, url: string | null, frame: 'a' | 'b')}
		<section class="pane" class:hidden={splitStore.zoom !== null && splitStore.zoom !== side}>
			{#if url}
				{#if frame === 'a'}
					<iframe bind:this={frameA} src={url} title={ref.target} allow="microphone; clipboard-read; clipboard-write"></iframe>
				{:else}
					<iframe bind:this={frameB} src={url} title={ref.target} allow="microphone; clipboard-read; clipboard-write"></iframe>
				{/if}
			{:else}
				<div class="unreachable">
					<iconify-icon icon="mdi:lan-disconnect"></iconify-icon>
					<p><b>{ref.host}</b> is not on the tailnet right now.</p>
					<button type="button" onclick={() => splitStore.close(side)}>Close this pane</button>
				</div>
			{/if}
			{#if splitStore.dragging}
				<!-- Frames swallow drag events; the overlay is where a drop lands. -->
				<div
					class="drop"
					role="region"
					aria-label="Drop a session here"
					ondragover={(e) => e.preventDefault()}
					ondrop={(e) => onDrop(side, e)}
				>
					Replace this pane
				</div>
			{/if}
			{#if resizing}
				<!-- Same reason: the frame must not eat the pointer mid-drag. -->
				<div class="shield"></div>
			{/if}
		</section>
	{/snippet}

	{@render pane('a', a, urlA, 'a')}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="divider"
		class:hidden={splitStore.zoom !== null}
		role="separator"
		aria-orientation="vertical"
		title="Drag to resize · double-click for 50/50"
		onpointerdown={startResize}
		onpointermove={moveResize}
		onpointerup={endResize}
		onpointercancel={endResize}
		ondblclick={() => splitStore.setRatio(0.5)}
	></div>
	{@render pane('b', b, urlB, 'b')}
</div>

<style>
	.split {
		display: grid;
		height: 100%;
		min-height: 0;
		min-width: 0;
	}
	.pane {
		position: relative;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	.pane.hidden {
		display: none;
	}
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: #0a0a0a;
	}
	.divider {
		background: #1f1f21;
		position: relative;
		cursor: col-resize;
		touch-action: none;
	}
	.divider.hidden {
		display: none;
	}
	.divider::after {
		content: '';
		position: absolute;
		left: 1px;
		right: 1px;
		top: 50%;
		height: 40px;
		transform: translateY(-50%);
		border-radius: 2px;
		background: #2a2a2c;
	}
	.divider:hover::after,
	.split.resizing .divider::after {
		background: #f59e0b;
	}
	.shield {
		position: absolute;
		inset: 0;
	}
	.drop {
		position: absolute;
		inset: 10px 10px 110px;
		display: grid;
		place-items: center;
		border: 2px dashed #818cf8;
		border-radius: 12px;
		background: rgba(129, 140, 248, 0.1);
		color: #a5b4fc;
		font: 500 13px system-ui, sans-serif;
	}
	.unreachable {
		height: 100%;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 8px;
		color: #a8a29e;
		font: 14px system-ui, sans-serif;
	}
	.unreachable iconify-icon {
		font-size: 28px;
		color: #6b6764;
	}
	.unreachable b {
		color: #e7e5e4;
		font-weight: 500;
	}
	.unreachable button {
		height: 30px;
		padding: 0 12px;
		border: 1px solid #2a2a2c;
		border-radius: 8px;
		background: #151516;
		color: #d6d3d1;
		cursor: pointer;
	}
</style>
