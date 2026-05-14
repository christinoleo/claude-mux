<script lang="ts">
	import AllSessionsPanel from '$lib/components/AllSessionsPanel.svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { STORAGE_KEYS } from '$lib/constants';

	let attempted = $state(false);

	$effect(() => {
		if (!browser || attempted) return;
		if (!sessionStore.connected) return;
		if (sessionStore.sessions.length === 0) return;

		attempted = true;

		const validTargets = new Set(
			sessionStore.sessions
				.map((s) => s.tmux_target)
				.filter((t): t is string => !!t)
		);

		let saved: string | null = null;
		try {
			saved = localStorage.getItem(STORAGE_KEYS.lastSession);
		} catch {
			// ignore
		}

		const pick =
			saved && validTargets.has(saved)
				? saved
				: sessionStore.sessions.find((s) => s.tmux_target)?.tmux_target;

		if (pick) {
			void goto(`/session/${encodeURIComponent(pick)}`, { replaceState: true });
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
