<script lang="ts">
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { wakeLockSupported } from '$lib/wakeLock.svelte';

	function barColor(percent: number): string {
		if (percent >= 90) return '#e74c3c';
		if (percent >= 70) return '#f39c12';
		return '#27ae60';
	}

	function formatMB(mb: number): string {
		if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
		return `${mb}M`;
	}

	const stats = $derived(sessionStore.systemStats);
	const supported = wakeLockSupported();
</script>

<div class="system-stats">
	<div class="stat-row">
		<span class="stat-label">CPU</span>
		<div class="stat-bar">
			<div class="stat-fill" style="width: {stats.cpu}%; background: {barColor(stats.cpu)}"></div>
		</div>
		<span class="stat-value">{stats.cpu}%</span>
	</div>
	<div class="stat-row">
		<span class="stat-label">RAM</span>
		<div class="stat-bar">
			<div class="stat-fill" style="width: {stats.ram}%; background: {barColor(stats.ram)}"></div>
		</div>
		<span class="stat-value">{stats.ram}%</span>
	</div>
	{#if stats.swapTotal > 0}
		<div class="stat-row">
			<span class="stat-label">SWP</span>
			<div class="stat-bar">
				<div class="stat-fill" style="width: {stats.swap}%; background: {barColor(stats.swap)}"></div>
			</div>
			<span class="stat-value">{stats.swap}%</span>
		</div>
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

	.stat-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.stat-label {
		font-size: 10px;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
		width: 26px;
		flex-shrink: 0;
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}

	.stat-bar {
		flex: 1;
		height: 6px;
		background: hsl(var(--muted));
		border-radius: 3px;
		overflow: hidden;
	}

	.stat-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 1s ease;
	}

	.stat-value {
		font-size: 10px;
		color: hsl(var(--muted-foreground));
		width: 28px;
		text-align: right;
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
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
