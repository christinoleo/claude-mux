<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onMount, onDestroy } from 'svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import SessionsSidebar from '$lib/components/SessionsSidebar.svelte';

	let { children } = $props();

	let drawerOpen = $state(false);
	let sidebarElement: HTMLElement | null = $state(null);
	let touchStartX = 0;
	let touchCurrentX = 0;
	let isDragging = false;

	// Resizable sidebar state
	const SIDEBAR_WIDTH_KEY = 'claude-watch-sidebar-width';
	const MIN_WIDTH = 200;
	const MAX_WIDTH = 500;
	const DEFAULT_WIDTH = 250;

	let sidebarWidth = $state(DEFAULT_WIDTH);
	let isResizing = $state(false);

	// Show sidebar only on session detail pages (not on main page)
	const showSidebar = $derived($page.url.pathname.startsWith('/session/'));

	// Connect session store at layout level so sidebar always has data
	onMount(() => {
		sessionStore.connect();
		// Load saved sidebar width
		if (browser) {
			const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
			if (saved) {
				const width = parseInt(saved, 10);
				if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
					sidebarWidth = width;
				}
			}
		}
	});

	onDestroy(() => {
		sessionStore.disconnect();
	});

	// Resize handlers
	function handleResizeStart(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		document.addEventListener('mousemove', handleResizeMove);
		document.addEventListener('mouseup', handleResizeEnd);
	}

	function handleResizeMove(e: MouseEvent) {
		if (!isResizing) return;
		const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
		sidebarWidth = newWidth;
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
	<div class="app-shell">
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
			<SessionsSidebar onSelect={closeDrawer} />
			<div
				class="resize-handle"
				onmousedown={handleResizeStart}
				role="separator"
				aria-orientation="vertical"
			></div>
		</aside>

		{#if drawerOpen}
			<button class="backdrop" onclick={closeDrawer} aria-label="Close menu"></button>
		{/if}

		<main class="content">
			<button class="hamburger" onclick={() => (drawerOpen = !drawerOpen)} aria-label="Toggle menu">
				<iconify-icon icon="mdi:menu"></iconify-icon>
			</button>
			{@render children()}
		</main>
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

	.app-shell:has(.sidebar.resizing) {
		cursor: col-resize;
		user-select: none;
	}

	.sidebar {
		width: var(--sidebar-width, 250px);
		flex-shrink: 0;
		background: hsl(var(--background));
		border-right: 1px solid hsl(var(--border));
		overflow: hidden;
		position: relative;
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

	.resize-handle:hover,
	.sidebar.resizing .resize-handle {
		background: hsl(var(--primary) / 0.5);
	}

	.content {
		flex: 1;
		overflow: hidden;
		position: relative;
	}

	.hamburger {
		display: none;
	}

	.backdrop {
		display: none;
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
