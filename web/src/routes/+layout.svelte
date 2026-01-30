<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onMount, onDestroy } from 'svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import SessionsSidebar from '$lib/components/SessionsSidebar.svelte';
	import AllSessionsPanel from '$lib/components/AllSessionsPanel.svelte';

	let { children } = $props();

	let drawerOpen = $state(false);
	let sidebarElement: HTMLElement | null = $state(null);
	let touchStartX = 0;
	let touchCurrentX = 0;
	let isDragging = false;

	// Desktop split-view detection
	const SPLIT_VIEW_BREAKPOINT = 1200;
	let isDesktop = $state(false);

	// Resizable sidebar state
	const SIDEBAR_WIDTH_KEY = 'claude-watch-sidebar-width';
	const SPLIT_PANEL_WIDTH_KEY = 'claude-watch-split-panel-width';
	const MIN_WIDTH = 200;
	const MAX_WIDTH = 500;
	const DEFAULT_WIDTH = 250;
	const DEFAULT_SPLIT_WIDTH = 350;

	let sidebarWidth = $state(DEFAULT_WIDTH);
	let splitPanelWidth = $state(DEFAULT_SPLIT_WIDTH);
	let isResizing = $state(false);
	let isResizingSplit = $state(false);
	let sidebarRightEdge = 0; // Track sidebar's right edge for resize calculation (when on right side)

	// Show sidebar only on session detail pages (not on main page)
	const showSidebar = $derived($page.url.pathname.startsWith('/session/'));

	// Connect session store at layout level so sidebar always has data
	onMount(() => {
		sessionStore.connect();

		// Desktop detection
		if (browser) {
			isDesktop = window.innerWidth >= SPLIT_VIEW_BREAKPOINT;

			const handleResize = () => {
				isDesktop = window.innerWidth >= SPLIT_VIEW_BREAKPOINT;
			};
			window.addEventListener('resize', handleResize);

			// Load saved sidebar width
			const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
			if (saved) {
				const width = parseInt(saved, 10);
				if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
					sidebarWidth = width;
				}
			}

			// Load saved split panel width
			const savedSplit = localStorage.getItem(SPLIT_PANEL_WIDTH_KEY);
			if (savedSplit) {
				const width = parseInt(savedSplit, 10);
				if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
					splitPanelWidth = width;
				}
			}

			return () => window.removeEventListener('resize', handleResize);
		}
	});

	onDestroy(() => {
		sessionStore.disconnect();
	});

	// Resize handlers
	function handleResizeStart(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		// Store the sidebar's right edge for resize calculation (sidebar is on right side on desktop)
		if (sidebarElement) {
			sidebarRightEdge = sidebarElement.getBoundingClientRect().right;
		}
		document.addEventListener('mousemove', handleResizeMove);
		document.addEventListener('mouseup', handleResizeEnd);
	}

	function handleResizeMove(e: MouseEvent) {
		if (!isResizing) return;
		// On desktop (sidebar on right): width = rightEdge - mouseX
		// On tablet (sidebar on left): width = mouseX - leftEdge (but we use rightEdge - (rightEdge - width) pattern)
		if (isDesktop) {
			// Sidebar is on the right, resize handle on left edge
			// Dragging left = increase width, dragging right = decrease width
			const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, sidebarRightEdge - e.clientX));
			sidebarWidth = newWidth;
		} else {
			// Sidebar is on the left, resize handle on right edge
			// Use left edge calculation: leftEdge = rightEdge - currentWidth
			const sidebarLeftEdge = sidebarRightEdge - sidebarWidth;
			const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - sidebarLeftEdge));
			sidebarWidth = newWidth;
		}
	}

	function handleResizeEnd() {
		isResizing = false;
		document.removeEventListener('mousemove', handleResizeMove);
		document.removeEventListener('mouseup', handleResizeEnd);
		// Save to localStorage
		if (browser) {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
		}
	}

	// Split panel resize handlers
	function handleSplitResizeStart(e: MouseEvent) {
		e.preventDefault();
		isResizingSplit = true;
		document.addEventListener('mousemove', handleSplitResizeMove);
		document.addEventListener('mouseup', handleSplitResizeEnd);
	}

	function handleSplitResizeMove(e: MouseEvent) {
		if (!isResizingSplit) return;
		const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
		splitPanelWidth = newWidth;
	}

	function handleSplitResizeEnd() {
		isResizingSplit = false;
		document.removeEventListener('mousemove', handleSplitResizeMove);
		document.removeEventListener('mouseup', handleSplitResizeEnd);
		// Save to localStorage
		if (browser) {
			localStorage.setItem(SPLIT_PANEL_WIDTH_KEY, splitPanelWidth.toString());
		}
	}

	function closeDrawer() {
		drawerOpen = false;
	}

	function handleTouchStart(e: TouchEvent) {
		touchStartX = e.touches[0].clientX;
		touchCurrentX = touchStartX;
		isDragging = true;
	}

	function handleTouchMove(e: TouchEvent) {
		if (!isDragging || !sidebarElement) return;
		touchCurrentX = e.touches[0].clientX;
		const diff = touchCurrentX - touchStartX;
		// Only allow dragging left (negative diff)
		if (diff < 0) {
			sidebarElement.style.transform = `translateX(${diff}px)`;
		}
	}

	function handleTouchEnd() {
		if (!isDragging || !sidebarElement) return;
		isDragging = false;
		const diff = touchCurrentX - touchStartX;
		// If swiped left more than 80px, close the drawer
		if (diff < -80) {
			closeDrawer();
		}
		// Reset transform to let CSS handle it
		sidebarElement.style.transform = '';
	}
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<script src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"></script>
</svelte:head>

{#if showSidebar}
	<div class="app-shell" class:split-view={isDesktop} class:resizing-any={isResizing || isResizingSplit}>
		<!-- Split panel (all sessions): only on desktop, LEFT side -->
		{#if isDesktop}
			<aside
				class="split-panel"
				class:resizing={isResizingSplit}
				style="--split-panel-width: {splitPanelWidth}px"
			>
				<AllSessionsPanel compact />
				<div
					class="resize-handle"
					onmousedown={handleSplitResizeStart}
					role="separator"
					aria-orientation="vertical"
				></div>
			</aside>
		{/if}

		<!-- Main content: CENTER -->
		<main class="content">
			<button class="hamburger" onclick={() => (drawerOpen = !drawerOpen)} aria-label="Toggle menu">
				<iconify-icon icon="mdi:menu"></iconify-icon>
			</button>
			{@render children()}
		</main>

		<!-- Project sidebar: RIGHT on desktop, LEFT on tablet, drawer on mobile -->
		<aside
			class="sidebar"
			class:open={drawerOpen}
			class:resizing={isResizing}
			style="--sidebar-width: {sidebarWidth}px"
			bind:this={sidebarElement}
			ontouchstart={handleTouchStart}
			ontouchmove={handleTouchMove}
			ontouchend={handleTouchEnd}
		>
			<!-- Left resize handle (desktop: sidebar on right) -->
			<div
				class="resize-handle resize-handle-left"
				onmousedown={handleResizeStart}
				role="separator"
				aria-orientation="vertical"
			></div>
			<SessionsSidebar onSelect={closeDrawer} hideSessionsList={isDesktop} />
			<!-- Right resize handle (tablet: sidebar on left) -->
			<div
				class="resize-handle resize-handle-right"
				onmousedown={handleResizeStart}
				role="separator"
				aria-orientation="vertical"
			></div>
		</aside>

		{#if drawerOpen}
			<button class="backdrop" onclick={closeDrawer} aria-label="Close menu"></button>
		{/if}
	</div>
{:else}
	{@render children()}
{/if}

<style>
	:global(body) {
		margin: 0;
		min-height: 100vh;
	}

	:global(iconify-icon) {
		font-size: 18px;
	}

	:global(iconify-icon.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	/* App shell with sidebar */
	.app-shell {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}

	.app-shell.resizing-any {
		cursor: col-resize;
		user-select: none;
	}

	/* Split panel for desktop */
	.split-panel {
		width: var(--split-panel-width, 350px);
		flex-shrink: 0;
		background: hsl(var(--background));
		border-right: 1px solid hsl(var(--border));
		overflow: hidden;
		position: relative;
	}

	.split-panel.resizing {
		user-select: none;
	}

	.split-panel .resize-handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 4px;
		height: 100%;
		cursor: col-resize;
		background: transparent;
		transition: background 0.15s;
	}

	.split-panel .resize-handle:hover,
	.split-panel.resizing .resize-handle {
		background: hsl(var(--primary) / 0.5);
	}

	.sidebar {
		width: var(--sidebar-width, 250px);
		flex-shrink: 0;
		background: hsl(var(--background));
		border-right: 1px solid hsl(var(--border));
		overflow: hidden;
		position: relative;
		order: 1; /* Default: left side (tablet) */
	}

	/* Desktop: sidebar moves to right */
	.split-view .sidebar {
		order: 3;
		border-right: none;
		border-left: 1px solid hsl(var(--border));
	}

	.sidebar.resizing {
		user-select: none;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 4px;
		height: 100%;
		cursor: col-resize;
		background: transparent;
		transition: background 0.15s;
	}

	/* Left-side resize handle (for right sidebar on desktop) */
	.resize-handle-left {
		right: auto;
		left: 0;
		display: none; /* Hidden by default (tablet/mobile) */
	}

	/* Right-side resize handle (for left sidebar on tablet) */
	.resize-handle-right {
		right: 0;
		left: auto;
		display: block; /* Shown by default (tablet) */
	}

	/* Desktop: show left handle, hide right handle on sidebar */
	.split-view .sidebar .resize-handle-left {
		display: block;
	}

	.split-view .sidebar .resize-handle-right {
		display: none;
	}

	.resize-handle:hover,
	.sidebar.resizing .resize-handle {
		background: hsl(var(--primary) / 0.5);
	}

	.content {
		flex: 1;
		overflow: hidden;
		position: relative;
		order: 2; /* Always in center */
	}

	.hamburger {
		display: none;
	}

	.backdrop {
		display: none;
	}

	/* Hide split panel below desktop breakpoint (CSS fallback) */
	@media (max-width: 1199px) {
		.split-panel {
			display: none;
		}
	}

	/* Mobile responsive */
	@media (max-width: 768px) {
		.sidebar {
			position: fixed;
			left: 0;
			top: 0;
			bottom: 0;
			width: 100% !important;
			z-index: 60;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
			background: hsl(var(--background) / 0.85);
			backdrop-filter: blur(12px);
			-webkit-backdrop-filter: blur(12px);
		}

		.sidebar.open {
			transform: translateX(0);
		}

		.resize-handle {
			display: none;
		}

		.hamburger {
			display: flex;
			align-items: center;
			justify-content: center;
			position: fixed;
			top: 12px;
			left: 12px;
			z-index: 50;
			width: 44px;
			height: 44px;
			background: hsl(var(--secondary));
			border: none;
			border-radius: 8px;
			color: hsl(var(--foreground));
			cursor: pointer;
			font-size: 22px;
		}

		.hamburger:hover {
			background: hsl(var(--accent));
		}

		.backdrop {
			display: block;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.4);
			z-index: 55;
			border: none;
			cursor: pointer;
		}
	}
</style>
