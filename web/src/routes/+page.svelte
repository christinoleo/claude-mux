<script lang="ts">
	import AllSessionsPanel from '$lib/components/AllSessionsPanel.svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { STORAGE_KEYS } from '$lib/constants';

	type Phase = 'waiting' | 'redirecting' | 'fallback';
	let phase = $state<Phase>('waiting');

	$effect(() => {
		if (!browser || phase !== 'waiting') return;

		if (sessionStore.sessions.length > 0) {
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
				phase = 'redirecting';
				void goto(`/session/${encodeURIComponent(pick)}`, { replaceState: true });
				return;
			}
			// No tmux-backed session to jump to (e.g. only sessions started outside tmux):
			// fall through and show the sessions panel instead of waiting forever.
		}

		if (sessionStore.connected) {
			// Show fallback only after first sessions message has had time to land.
			const t = setTimeout(() => {
				if (phase === 'waiting') phase = 'fallback';
			}, 300);
			return () => clearTimeout(t);
		}
	});
</script>

<svelte:head>
	<title>claude-mux</title>
</svelte:head>

{#if phase === 'fallback'}
	<div class="root-page">
		<AllSessionsPanel />
	</div>
{/if}

<style>
	.root-page {
		height: 100dvh;
		max-width: 800px;
		margin: 0 auto;
	}
</style>
