<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onMount, onDestroy } from 'svelte';
	import { drawer } from '$lib/stores/drawer.svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { acquireWakeLock, releaseWakeLock } from '$lib/wakeLock.svelte';
	import AllSessionsPanel from '$lib/components/AllSessionsPanel.svelte';
	import ScreenshotsPanel from '$lib/components/ScreenshotsPanel.svelte';
	import MessageQueuePanel from '$lib/components/MessageQueuePanel.svelte';
	import SidebarMeters from '$lib/components/SidebarMeters.svelte';
	import { STORAGE_KEYS } from '$lib/constants';

	let { children } = $props();

	/** Driven from the session composer's status line, which carries the toggle. */
	const drawerOpen = $derived(drawer.open);
	let sidebarElement: HTMLElement | null = $state(null);
	let touchStartX = 0;
	let touchCurrentX = 0;
	let isDragging = false;

	// Resizable sidebar state
	const SIDEBAR_WIDTH_KEY = STORAGE_KEYS.sidebarWidth;
	const MIN_WIDTH = 200;
	const MAX_WIDTH = 500;
	const DEFAULT_WIDTH = 300;

	let sidebarWidth = $state(DEFAULT_WIDTH);
	let isResizing = $state(false);

	// Show sidebar only on session detail pages (not on main page)
	const showSidebar = $derived($page.url.pathname.startsWith('/session/'));

	// Current session for screenshots panel
	const currentTarget = $derived(
		$page.url.pathname.startsWith('/session/')
			? decodeURIComponent($page.url.pathname.split('/session/')[1])
			: null
	);

	const currentSession = $derived(
		sessionStore.sessions.find((s) => s.tmux_target === currentTarget || s.id === currentTarget)
	);

	// Connect session store at layout level so sidebar always has data
	onMount(() => {
		sessionStore.connect();

		if (browser) {
			// Load saved sidebar width
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
		if (browser) void releaseWakeLock();
	});

	function handleVisibility() {
		if (document.visibilityState === 'visible' && preferences.keepAwake) {
			void acquireWakeLock();
		}
	}

	$effect(() => {
		if (!browser) return;
		if (preferences.keepAwake) void acquireWakeLock();
		else void releaseWakeLock();
	});

	$effect(() => {
		if (!browser) return;
		document.addEventListener('visibilitychange', handleVisibility);
		return () => document.removeEventListener('visibilitychange', handleVisibility);
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
		if (browser) {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
		}
	}

	/** The sidebar's own shortcut, the one VS Code taught everyone. */
	function handleSidebarKey(e: KeyboardEvent) {
		if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
		if (e.key.toLowerCase() !== 'b') return;
		e.preventDefault();
		drawer.toggle();
	}

	function closeDrawer() {
		drawer.close();
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
		if (diff < 0) {
			sidebarElement.style.transform = `translateX(${diff}px)`;
		}
	}

	function handleTouchEnd() {
		if (!isDragging || !sidebarElement) return;
		isDragging = false;
		const diff = touchCurrentX - touchStartX;
		if (diff < -80) {
			closeDrawer();
		}
		sidebarElement.style.transform = '';
	}
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover" />
	<script src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"></script>
</svelte:head>

<svelte:window onkeydown={handleSidebarKey} />

{#if showSidebar}
	<div class="app-shell" class:resizing-any={isResizing}>
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
			<div class="sidebar-content">
				<AllSessionsPanel compact onSessionSelect={closeDrawer} />

				{#if currentTarget}
					<div class="sidebar-panel">
						<MessageQueuePanel target={currentTarget} />
					</div>
				{/if}

				{#if currentSession}
					<div class="sidebar-panel">
						<ScreenshotsPanel
							sessionId={currentSession.id}
							screenshots={currentSession.screenshots ?? []}
						/>
					</div>
				{/if}
			</div>
			<SidebarMeters />
			<div
				class="resize-handle"
				onmousedown={handleResizeStart}
				role="separator"
				aria-orientation="vertical"
			></div>
		</aside>

		<main class="content">
			{@render children()}
		</main>

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
		min-height: 100dvh;
		/* Matches the header/toolbar so the iOS status-bar & home-indicator areas blend in */
		background: #111;
	}

	:global(iconify-icon) {
		font-size: 18px;
	}

	:global(iconify-icon.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.app-shell {
		display: flex;
		height: 100dvh;
		overflow: hidden;
		box-sizing: border-box;
		/* Keep UI out from under the notch / home indicator in standalone (PWA) mode */
		padding-top: env(safe-area-inset-top);
		padding-bottom: env(safe-area-inset-bottom);
		padding-left: env(safe-area-inset-left);
		padding-right: env(safe-area-inset-right);
	}

	.app-shell.resizing-any {
		cursor: col-resize;
		user-select: none;
	}

	.sidebar {
		width: var(--sidebar-width, 300px);
		flex-shrink: 0;
		background: hsl(var(--background));
		border-right: 1px solid hsl(var(--border));
		overflow: hidden;
		position: relative;
		display: flex;
		flex-direction: column;
	}

	.sidebar.resizing {
		user-select: none;
	}

	.sidebar-content {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.sidebar-panel {
		flex-shrink: 0;
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
		background: color-mix(in oklch, var(--primary), transparent 50%);
	}

	.content {
		flex: 1;
		overflow: hidden;
		position: relative;
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
			box-sizing: border-box;
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
			z-index: 60;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
			background: hsl(var(--background) / 0.85);
			backdrop-filter: blur(12px);
			-webkit-backdrop-filter: blur(12px);
		}

		/* Closed drawer is off-screen but still composited — without this its
		   busy dots keep animating behind the blur. */
		.sidebar:not(.open) {
			content-visibility: hidden;
		}

		.sidebar.open {
			transform: translateX(0);
		}

		.resize-handle {
			display: none;
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
