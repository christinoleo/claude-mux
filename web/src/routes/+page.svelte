<script lang="ts">
	import AllSessionsPanel from '$lib/components/AllSessionsPanel.svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	$effect(() => {
		if (!browser) return;
		if ($page.url.searchParams.get('resume') !== '1') return;
		let target: string | null = null;
		try {
			target = localStorage.getItem('claude-mux-last-session');
		} catch {
			return;
		}
		if (target) {
			void goto(`/session/${encodeURIComponent(target)}`, {
				replaceState: true,
				state: { resumed: true }
			});
		}
	});
</script>

<svelte:head>
	<title>claude-mux</title>
</svelte:head>

<div class="root-page">
	<AllSessionsPanel />
</div>

<style>
	.root-page {
		height: 100vh;
		max-width: 800px;
		margin: 0 auto;
	}
</style>
