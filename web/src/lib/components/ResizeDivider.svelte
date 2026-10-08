<script lang="ts">
	/**
	 * A vertical bar dragged sideways to resize what sits on either side of it.
	 * It captures the pointer so a drag that leaves the bar keeps going; while
	 * `resizing`, the owner draws a shield over any iframe, which would
	 * otherwise swallow the pointer mid-drag.
	 */
	let {
		resizing = $bindable(false),
		title,
		onmove,
		onend,
		onreset
	}: {
		resizing?: boolean;
		title: string;
		/** The pointer moved during a drag. */
		onmove: (e: PointerEvent) => void;
		/** The drag ended. */
		onend?: () => void;
		/** Double-click: back to the default size. */
		onreset?: () => void;
	} = $props();

	function start(e: PointerEvent) {
		resizing = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (resizing) onmove(e);
	}
	function end() {
		if (!resizing) return;
		resizing = false;
		onend?.();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="divider"
	class:resizing
	role="separator"
	aria-orientation="vertical"
	{title}
	onpointerdown={start}
	onpointermove={move}
	onpointerup={end}
	onpointercancel={end}
	ondblclick={onreset}
></div>

<style>
	.divider {
		width: 100%;
		height: 100%;
		background: #1f1f21;
		position: relative;
		cursor: col-resize;
		touch-action: none;
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
	.divider.resizing::after {
		background: #f59e0b;
	}
</style>
