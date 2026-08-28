<script lang="ts">
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { wakeLockSupported } from '$lib/wakeLock.svelte';
	import MeterBar from './MeterBar.svelte';
	import { severityForPercent } from '$lib/severity';

	const stats = $derived(sessionStore.systemStats);
	const supported = wakeLockSupported();
</script>

<div class="system-stats">
	<MeterBar label="CPU" percent={stats.cpu} severity={severityForPercent(stats.cpu)} compact />
	<MeterBar label="RAM" percent={stats.ram} severity={severityForPercent(stats.ram)} compact />
	{#if stats.swapTotal > 0}
		<MeterBar label="SWP" percent={stats.swap} severity={severityForPercent(stats.swap)} compact />
	{/if}
	{#if supported}
		<label class="awake-row">
			<input
				type="checkbox"
				checked={preferences.keepAwake}
				onchange={(e) => (preferences.keepAwake = e.currentTarget.checked)}
			/>
			<span>Keep screen on</span>
		</label>
	{/if}
</div>

<style>
	.system-stats {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 12px;
		border-top: 1px solid hsl(var(--border));
		background: hsl(var(--background));
	}

	.awake-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		cursor: pointer;
		user-select: none;
	}

	.awake-row input {
		margin: 0;
		cursor: pointer;
	}
</style>
