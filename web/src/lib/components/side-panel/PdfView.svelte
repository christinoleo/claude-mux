<script lang="ts">
	/**
	 * A PDF as a column of pages, each as wide as the pane. A page holds a bitmap
	 * only while it is near the screen, or a long document would run a phone out
	 * of memory.
	 */
	import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from 'pdfjs-dist';
	import { untrack } from 'svelte';
	import { openPdf } from '$lib/side-panel/pdf';

	let { src }: { src: string } = $props();

	/** Sharper than this costs memory a reader cannot see. */
	const MAX_PIXEL_RATIO = 2;

	/** How long the pane's width must hold before the pages are drawn again for it. */
	const RESIZE_SETTLE_MS = 150;

	/** Fetched up front, so the column has its full height before anything is drawn. A page that will not load is null. */
	let pages = $state.raw<(PDFPageProxy | null)[] | null>(null);
	/** Pages that would not draw; the rest of the document still reads. */
	let unreadable = $state.raw(new Set<number>());
	let failed = $state<string | null>(null);
	let scroller = $state<HTMLElement | null>(null);
	let paneWidth = $state(0);
	/** The width pages are drawn at. A canvas stretches to the pane while a drag goes on. */
	let drawWidth = $state(0);

	$effect(() => {
		const width = paneWidth;
		if (!untrack(() => drawWidth)) return void (drawWidth = width);
		const settle = setTimeout(() => (drawWidth = width), RESIZE_SETTLE_MS);
		return () => clearTimeout(settle);
	});

	$effect(() => {
		const url = src;
		let gone = false;
		let loading: PDFDocumentLoadingTask | null = null;
		pages = null;
		unreadable = new Set();
		failed = null;
		void (async () => {
			try {
				const task = await openPdf(url);
				if (gone) return void task.destroy();
				loading = task;
				const pdf = await task.promise;
				const all = await Promise.all(
					Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).catch(() => null))
				);
				if (!gone) pages = all;
			} catch (err) {
				if (!gone) failed = err instanceof Error ? err.message : String(err);
			}
		})();
		return () => {
			gone = true;
			void loading?.destroy();
		};
	});

	/** Draws a page into its canvas while it is near the screen, and lets go of the bitmap after. */
	function drawPage(page: PDFPageProxy, index: number) {
		return (canvas: HTMLCanvasElement) => {
			const cssWidth = drawWidth;
			if (!cssWidth) return;
			let task: RenderTask | null = null;

			function draw() {
				const scale = (cssWidth / page.getViewport({ scale: 1 }).width) * Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
				const viewport = page.getViewport({ scale });
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				task = page.render({ canvas, viewport });
				task.promise.catch((err: Error) => {
					if (err.name !== 'RenderingCancelledException') unreadable = new Set(unreadable).add(index);
				});
			}

			function release() {
				task?.cancel();
				task = null;
			}

			const seen = new IntersectionObserver(
				(entries) => {
					release();
					// Oldest first: only the last says where the page is now.
					if (entries[entries.length - 1].isIntersecting) return draw();
					canvas.width = canvas.height = 0;
					page.cleanup();
				},
				{ root: scroller, rootMargin: '100% 0px' }
			);
			seen.observe(canvas);
			return () => {
				seen.disconnect();
				release();
			};
		};
	}
</script>

<div class="pdf" bind:this={scroller} bind:clientWidth={paneWidth}>
	{#if failed}
		<p class="msg">Could not show this PDF: {failed}</p>
	{:else if !pages}
		<p class="msg">Loading…</p>
	{:else}
		{#each pages as page, i (i)}
			{#if !page || unreadable.has(i)}
				<p class="msg">Could not show page {i + 1}.</p>
			{:else}
				{@const { width, height } = page.getViewport({ scale: 1 })}
				<canvas
					aria-label="Page {i + 1} of {pages.length}"
					style:aspect-ratio="{width} / {height}"
					{@attach drawPage(page, i)}
				></canvas>
			{/if}
		{/each}
	{/if}
</div>

<style>
	.pdf {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px 0 24px;
		background: #111;
		/* The pane's width without the bar, whether the bar takes room or floats. */
		scrollbar-gutter: stable;
	}
	canvas {
		display: block;
		flex: none;
		width: 100%;
		background: #fff;
	}
	.msg {
		margin: 0;
		padding: 16px 18px;
		color: #78716c;
	}
</style>
