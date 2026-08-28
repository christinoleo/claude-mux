<script lang="ts">
	import { formatElapsed } from '$lib/format';
	import { voiceStore } from '$lib/stores/voice.svelte';

	interface Props {
		target: string | null;
	}

	let { target }: Props = $props();

	const BARS = 12;

	/**
	 * Recording state, hung above the microphone it belongs to: level, clock,
	 * and the way out. Anchored to the button's right edge so a phone never
	 * pushes it off screen.
	 */
	const owned = $derived(voiceStore.isOwnedBy(target));
	const showing = $derived(owned && voiceStore.isActive);
	const status = $derived(owned ? voiceStore.status : 'idle');
	const lit = $derived(Math.min(BARS, Math.round(voiceStore.level.rms * 26)));
	const clipping = $derived(voiceStore.level.peak >= 0.98);
	const tooSoft = $derived(voiceStore.level.peak < 0.04);

	/** Read off the store's own start, so a meter that mounts mid-take is right. */
	let now = $state(Date.now());

	$effect(() => {
		if (status !== 'recording') return;
		const id = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(id);
	});

	const elapsed = $derived(
		voiceStore.startedAt === null ? '0:00' : formatElapsed((now - voiceStore.startedAt) / 1000)
	);
</script>

{#if showing}
	<div class="meter" class:clipping>
		<span
			class="bars"
			title={clipping
				? 'Clipping — too loud'
				: tooSoft
					? 'Too soft — speak louder or raise gain'
					: `Level ${(voiceStore.level.rms * 100).toFixed(0)}%`}
		>
			{#each Array(BARS) as _, i (i)}
				<span class="bar" class:on={i < lit} style="--i: {i}"></span>
			{/each}
		</span>
		<span class="clock">
			{status === 'recording' ? elapsed : 'transcribing'}
		</span>
		<button
			type="button"
			class="drop"
			aria-label="Discard recording"
			title="Discard recording / transcription"
			onclick={() => void voiceStore.cancel()}
		>
			<iconify-icon icon="mdi:close"></iconify-icon>
		</button>
	</div>
{/if}

<style>
	.meter {
		position: absolute;
		bottom: calc(100% + 8px);
		right: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 4px 0 10px;
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 16px;
		white-space: nowrap;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
	}
	.clipping {
		border-color: rgba(220, 38, 38, 0.6);
	}

	.bars {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 16px;
	}
	.bar {
		width: 2px;
		height: calc(5px + var(--i) * 0.9px);
		border-radius: 1px;
		background: #3f3c39;
	}
	.bar.on {
		background: #34d399;
	}
	.bar.on:nth-child(n + 9) {
		background: #fbbf24;
	}
	.bar.on:nth-child(n + 12) {
		background: #f87171;
	}

	.clock {
		font-family: var(--font-mono);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: #a8a29e;
	}

	.drop {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 0;
		background: transparent;
		color: #fca5a5;
		font-size: 15px;
		cursor: pointer;
	}
	.drop:hover {
		background: rgba(220, 38, 38, 0.18);
	}
</style>
