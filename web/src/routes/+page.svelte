<script lang="ts">
	import AllSessionsPanel from '$lib/components/AllSessionsPanel.svelte';
</script>

<svelte:head>
	<title>claude-watch</title>
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
