<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { voiceStore } from '$lib/stores/voice.svelte';

	interface Props {
		target: string | null;
		onTranscript?: (text: string) => void;
	}

	let { target, onTranscript }: Props = $props();

	const supported = $derived(voiceStore.supported);
	const status = $derived(voiceStore.status);
	const errorMsg = $derived(voiceStore.error);

	let pressed = $state(false);
	let elapsed = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;

	function tickElapsed(): void {
		const startedAt = voiceStore.startedAt;
		if (startedAt) elapsed = Math.floor((Date.now() - startedAt) / 1000);
	}

	function startElapsedTimer(): void {
		stopElapsedTimer();
		elapsed = 0;
		tickElapsed();
		elapsedTimer = setInterval(tickElapsed, 250);
	}

	function stopElapsedTimer(): void {
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
		elapsed = 0;
	}

	async function handlePointerDown(e: PointerEvent): Promise<void> {
		if (!target || !supported || status === 'transcribing') return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		pressed = true;

		if (status === 'error') voiceStore.clearError();
		await voiceStore.startRecording();
		if (voiceStore.status === 'recording') startElapsedTimer();
	}

	async function handlePointerEnd(e: PointerEvent): Promise<void> {
		if (!pressed) return;
		pressed = false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		stopElapsedTimer();

		if (!target || voiceStore.status !== 'recording') return;
		const text = await voiceStore.stopAndSend(target);
		if (text) onTranscript?.(text);
	}

	function handlePointerCancel(): void {
		if (!pressed) return;
		pressed = false;
		stopElapsedTimer();
		voiceStore.cancel();
	}

	function formatElapsed(s: number): string {
		const m = Math.floor(s / 60);
		const r = s % 60;
		return `${m}:${r.toString().padStart(2, '0')}`;
	}

	onDestroy(() => {
		stopElapsedTimer();
	});
</script>

{#if supported}
	<div class="voice-wrap">
		<Button
			variant={status === 'recording' ? 'destructive' : status === 'error' ? 'destructive' : 'secondary'}
			size="toolbar"
			class="flex-1 voice-btn {status}"
			disabled={!target || status === 'transcribing'}
			onpointerdown={handlePointerDown}
			onpointerup={handlePointerEnd}
			onpointerleave={handlePointerEnd}
			onpointercancel={handlePointerCancel}
			title={errorMsg ?? 'Hold to talk'}
		>
			{#if status === 'transcribing'}
				<iconify-icon icon="mdi:loading" class="spin"></iconify-icon>
				<span>...</span>
			{:else if status === 'recording'}
				<iconify-icon icon="mdi:microphone"></iconify-icon>
				<span>{formatElapsed(elapsed)}</span>
			{:else if status === 'error'}
				<iconify-icon icon="mdi:microphone-off"></iconify-icon>
				<span>Mic</span>
			{:else}
				<iconify-icon icon="mdi:microphone"></iconify-icon>
				<span>Hold</span>
			{/if}
		</Button>
	</div>
{/if}

<style>
	.voice-wrap {
		display: contents;
	}

	:global(.voice-btn) {
		touch-action: none;
		user-select: none;
	}

	:global(.voice-btn.recording) {
		animation: voice-pulse 1.2s ease-in-out infinite;
	}

	@keyframes voice-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.6); }
		50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
	}

	.spin {
		animation: voice-spin 1s linear infinite;
		display: inline-block;
	}

	@keyframes voice-spin {
		to { transform: rotate(360deg); }
	}
</style>
