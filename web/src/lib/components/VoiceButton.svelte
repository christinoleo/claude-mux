<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { voiceStore } from '$lib/stores/voice.svelte';

	interface Props {
		target: string | null;
	}

	let { target }: Props = $props();

	const supported = $derived(voiceStore.supported);
	const status = $derived(voiceStore.status);
	const errorMsg = $derived(voiceStore.error);
	const variant = $derived(
		status === 'recording' || status === 'error' ? 'destructive' : 'secondary'
	);

	let elapsed = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;

	function tickElapsed(): void {
		const next = voiceStore.startedAt
			? Math.floor((Date.now() - voiceStore.startedAt) / 1000)
			: 0;
		if (next !== elapsed) elapsed = next;
	}

	function startElapsedTimer(): void {
		stopElapsedTimer();
		elapsed = 0;
		elapsedTimer = setInterval(tickElapsed, 1000);
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

		await voiceStore.startRecording();
		if (voiceStore.status === 'recording') startElapsedTimer();
	}

	async function handlePointerUp(e: PointerEvent): Promise<void> {
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		stopElapsedTimer();
		if (!target || voiceStore.status !== 'recording') return;
		await voiceStore.stopAndSend(target);
	}

	function handlePointerCancel(): void {
		stopElapsedTimer();
		if (voiceStore.status === 'recording') voiceStore.cancel();
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
	<Button
		{variant}
		size="toolbar"
		class="flex-1 voice-btn {status}"
		disabled={!target || status === 'transcribing'}
		onpointerdown={handlePointerDown}
		onpointerup={handlePointerUp}
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
{/if}

<style>
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
