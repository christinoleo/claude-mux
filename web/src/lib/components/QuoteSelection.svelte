<script lang="ts">
	/**
	 * "Add to prompt" for a selection in the transcript: a button that floats
	 * by the selected text, and Ctrl/Cmd+L. Both hand the text to `onQuote`.
	 * With nothing quotable selected neither does anything, so Ctrl+L keeps
	 * the browser's meaning.
	 */
	import { MediaQuery } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button';
	import { IS_MAC } from '$lib/constants';
	import { quotableRanges, takeQuote } from '$lib/quote';

	let {
		root,
		onQuote
	}: {
		/** The transcript; only a selection inside it counts. */
		root: HTMLElement | null;
		onQuote: (text: string) => void;
	} = $props();

	/** Room for the button above a selection, and its gap from the text. */
	const ABOVE = 40;
	const GAP = 8;
	/** On touch the button goes below, clear of the selection handles; the system menu takes the top. */
	const HANDLES = 28;
	/** A selection still being dragged out by its handles moves many times a second. */
	const SETTLE_MS = 200;
	/** How long after a finger leaves the button its click may still arrive. */
	const PRESS_MS = 400;

	const touch = new MediaQuery('(pointer: coarse)');
	const coarse = $derived(touch.current);

	// Kept as ranges, not text: a tap on the button can end the selection on a
	// phone before the click arrives, and the ranges outlive it.
	let ranges: Range[] = [];
	/** Where the button goes: the selection's middle, and the top of the button. */
	let place = $state<{ left: number; top: number } | null>(null);
	let width = $state(0);
	/** Its left edge, kept on the screen whatever the selection's middle is. */
	const left = $derived(
		place ? Math.max(GAP, Math.min(place.left - width / 2, window.innerWidth - width - GAP)) : 0
	);
	let dragging = false;
	/** A finger is on the button: the selection it ends by landing there must not take the button away. */
	let pressing = false;
	/** The shortcut's key is still down from a quote it made. */
	let held = false;
	let settle: ReturnType<typeof setTimeout> | null = null;
	let frame = 0;

	function position() {
		if (ranges.length === 0) {
			place = null;
			return;
		}
		const first = ranges[0].getBoundingClientRect();
		const last = ranges[ranges.length - 1].getBoundingClientRect();
		const top = first.top;
		const bottom = last.bottom;
		if (bottom < 0 || top > window.innerHeight || (first.width === 0 && first.height === 0)) {
			place = null;
			return;
		}
		const left = Math.min(first.left, last.left);
		const right = Math.max(first.right, last.right);
		const below = coarse || top < ABOVE + GAP;
		place = {
			left: (left + right) / 2,
			top: below
				? Math.min(bottom + (coarse ? HANDLES : GAP), window.innerHeight - ABOVE)
				: top - ABOVE
		};
	}

	function selected(): Range[] {
		return root ? quotableRanges(root, window.getSelection()) : [];
	}

	function read() {
		ranges = selected();
		position();
	}

	function readAfter(ms: number) {
		if (settle) clearTimeout(settle);
		settle = setTimeout(read, ms);
	}

	function quote(from: Range[]) {
		if (!root || from.length === 0) return false;
		const text = takeQuote(root, from);
		pressing = false;
		ranges = [];
		place = null;
		if (text) onQuote(text);
		return text !== '';
	}

	$effect(() => {
		if (!root) return;
		const onSelection = () => {
			if (settle) clearTimeout(settle);
			// Mid-drag the button would sit under the pointer; it waits for the release.
			if (dragging || pressing) return;
			// Handles being dragged would have the button under the finger; a
			// selection grown from the keyboard just moves it along.
			if (coarse) place = null;
			readAfter(coarse ? SETTLE_MS : 0);
		};
		const onDown = (e: PointerEvent) => {
			pressing = e.target instanceof Element && e.target.closest('.quote-selection') !== null;
			if (pressing) return;
			dragging = e.pointerType === 'mouse';
			if (dragging) place = null;
		};
		const onUp = () => {
			if (pressing) {
				// The click is still to come; a press that slid off the button never sends one.
				if (settle) clearTimeout(settle);
				settle = setTimeout(() => {
					pressing = false;
					read();
				}, PRESS_MS);
			}
			if (!dragging) return;
			dragging = false;
			// The selection a click collapses is still whole at this point.
			readAfter(0);
		};
		const onScroll = () => {
			if (ranges.length === 0) return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(position);
		};
		const onKey = (e: KeyboardEvent) => {
			// By position, as the side panel's keys are: `key` is another letter on a non-Latin layout.
			if (e.code !== 'KeyL' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
			if (e.defaultPrevented) return;
			// A key held down repeats after the quote is taken, and would then reach the address bar.
			if (e.repeat) {
				if (held) e.preventDefault();
				return;
			}
			// Typed into something else (a field, the Browser pane), the key is that thing's.
			const focus = document.activeElement;
			if (focus && focus !== document.body && !root.contains(focus)) return;
			held = quote(selected());
			if (held) e.preventDefault();
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.code === 'KeyL') held = false;
		};

		document.addEventListener('selectionchange', onSelection);
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('pointerup', onUp, true);
		document.addEventListener('pointercancel', onUp, true);
		document.addEventListener('keydown', onKey);
		document.addEventListener('keyup', onKeyUp);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onScroll);
		return () => {
			document.removeEventListener('selectionchange', onSelection);
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('pointerup', onUp, true);
			document.removeEventListener('pointercancel', onUp, true);
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onScroll);
			if (settle) clearTimeout(settle);
			cancelAnimationFrame(frame);
		};
	});
</script>

{#if place}
	<div class="quote-selection" bind:offsetWidth={width} style:left="{left}px" style:top="{place.top}px">
		<!-- The press must not take the focus, or the selection it acts on is gone. -->
		<Button
			variant="secondary"
			size="sm"
			class="quote-button"
			onpointerdown={(e: PointerEvent) => e.preventDefault()}
			onmousedown={(e: MouseEvent) => e.preventDefault()}
			onclick={() => quote(ranges)}
		>
			<iconify-icon icon="mdi:format-quote-close" aria-hidden="true"></iconify-icon>
			Add to prompt
			{#if !coarse}<kbd>{IS_MAC ? '⌘L' : 'Ctrl L'}</kbd>{/if}
		</Button>
	</div>
{/if}

<style>
	.quote-selection {
		position: fixed;
		z-index: var(--z-floating);
		/* The native selection menu and handles stay the system's to draw. */
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		animation: quote-in 120ms ease-out;
	}

	.quote-selection :global(.quote-button) {
		border: 1px solid #44403c;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
		font-size: 13px;
	}

	.quote-selection :global(iconify-icon) {
		font-size: 16px;
		color: #a8a29e;
	}

	kbd {
		margin-left: 2px;
		padding: 1px 5px;
		border: 1px solid #44403c;
		border-radius: 4px;
		color: #a8a29e;
		font:
			11px ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
	}

	@keyframes quote-in {
		from {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.quote-selection {
			animation: none;
		}
	}
</style>
