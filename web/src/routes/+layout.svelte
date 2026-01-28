<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import SessionsSidebar from '$lib/components/SessionsSidebar.svelte';

	let { children } = $props();

	let drawerOpen = $state(false);

	// Show sidebar only on session detail pages (not on main page)
	const showSidebar = $derived($page.url.pathname.startsWith('/session/'));

	// Connect session store at layout level so sidebar always has data
	onMount(() => {
		sessionStore.connect();
	});

	onDestroy(() => {
		sessionStore.disconnect();
	});

	function closeDrawer() {
		drawerOpen = false;
	}
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<script src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"></script>
</svelte:head>

{#if showSidebar}
	<div class="app-shell">
		<aside class="sidebar" class:open={drawerOpen}>
			<SessionsSidebar onSelect={closeDrawer} />
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
	:global(*) {
		box-sizing: border-box;
	}

	:global(body) {
		font-family: -apple-system, system-ui, sans-serif;
		background: #0a0a0a;
		color: #eee;
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

	.sidebar {
		width: 250px;
		flex-shrink: 0;
		border-right: 1px solid #222;
		overflow: hidden;
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
			z-index: 60;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
		}

		.sidebar.open {
			transform: translateX(0);
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
			background: #222;
			border: none;
			border-radius: 8px;
			color: #fff;
			cursor: pointer;
			font-size: 22px;
		}

		.hamburger:hover {
			background: #333;
		}

		.backdrop {
			display: block;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.7);
			z-index: 55;
			border: none;
			cursor: pointer;
		}
	}
</style>
