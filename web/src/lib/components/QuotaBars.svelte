<script lang="ts">
	import MeterBar from './MeterBar.svelte';
	import { SEVERITY } from '$lib/severity';
	import type { QuotaResult, QuotaUnavailable } from '$lib/types/usage';

	interface Props {
		quota: QuotaResult | null;
		/** Sidebar rendering: bars only, no icons or reset times. */
		compact?: boolean;
	}

	let { quota, compact = false }: Props = $props();

	const REASONS: Record<QuotaUnavailable, string> = {
		'no-credentials': 'Not signed in to Claude on this machine.',
		'token-expired': 'Sign-in token expired — run Claude Code once to renew it.',
		unauthorized: 'Claude rejected the stored sign-in.',
		unreachable: 'Could not reach Claude to read plan limits.',
		'no-limits': 'Plan limits do not apply to this account.'
	};

	/**
	 * "2h 5m", "1d 3h", "12m" — enough precision to plan around, never more.
	 * Rounded, not truncated, so it agrees with the absolute time beside it.
	 */
	function resetsIn(atMs: number, nowMs: number): string {
		const ms = atMs - nowMs;
		if (ms <= 0) return 'resetting';
		const minutes = Math.round(ms / 60_000);
		if (minutes < 60) return `${minutes}m`;
		if (minutes < 24 * 60) {
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
		}
		const hours = Math.round(minutes / 60);
		const days = Math.floor(hours / 24);
		const restHours = hours % 24;
		return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
	}

	/** "Sep 6, 3:00 AM" in the viewer's own zone, the way Claude Code's /usage prints it. */
	function resetsAt(atMs: number, nowMs: number): string {
		const at = new Date(atMs);
		const sameDay = at.toDateString() === new Date(nowMs).toDateString();
		return at.toLocaleString(undefined, {
			...(sameDay ? {} : { month: 'short', day: 'numeric' }),
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function resetNote(atMs: number, nowMs: number): string {
		return `resets in ${resetsIn(atMs, nowMs)} · ${resetsAt(atMs, nowMs)}`;
	}

	/** Ticks once a minute so a page left open keeps counting down. */
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	const limits = $derived(quota?.available ? quota.limits : []);
</script>

{#if quota && !quota.available}
	<p class="unavailable">{REASONS[quota.reason] ?? 'Plan limits unavailable.'}</p>
{:else if limits.length > 0}
	<ul class="quota" class:compact>
		{#each limits as limit (limit.kind + limit.label)}
			<li>
				<MeterBar
					label={limit.label}
					percent={limit.percent}
					severity={limit.severity}
					showIcon={!compact}
					footLeft={compact ? undefined : SEVERITY[limit.severity].word}
					footRight={compact || limit.resetsAtMs === null
						? undefined
						: resetNote(limit.resetsAtMs, now)}
					{compact}
				/>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.quota {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 12px;
	}

	.quota.compact {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	li {
		min-width: 0;
	}

	.unavailable {
		color: #a8a29e;
		font-size: 12px;
		margin: 0;
	}

	@media (max-width: 720px) {
		.quota:not(.compact) {
			grid-template-columns: 1fr;
			gap: 14px;
		}
	}
</style>
