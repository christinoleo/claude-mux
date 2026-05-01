<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { longPress } from '$lib/actions/longPress';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { voiceStore, type VoiceLanguage } from '$lib/stores/voice.svelte';
	import { listAudioInputs, type AudioInputDevice } from '$lib/voice/recorder';

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

	const MAX_RECORDING_MS = 10 * 60 * 1000;
	const LONG_TRANSCRIBE_MS = 5000;

	let elapsed = $state(0);
	let isLongTranscribe = $state(false);
	let menuOpen = $state(false);
	let devices = $state<AudioInputDevice[]>([]);

	$effect(() => {
		if (status !== 'transcribing') {
			isLongTranscribe = false;
			return;
		}
		const id = setTimeout(() => {
			isLongTranscribe = true;
		}, LONG_TRANSCRIBE_MS);
		return () => clearTimeout(id);
	});

	$effect(() => {
		if (status !== 'recording') {
			elapsed = 0;
			return;
		}
		elapsed = 0;
		const tick = setInterval(() => {
			const next = voiceStore.startedAt
				? Math.floor((Date.now() - voiceStore.startedAt) / 1000)
				: 0;
			if (next !== elapsed) elapsed = next;
		}, 1000);
		const auto = setTimeout(() => void toggleVoice(), MAX_RECORDING_MS);
		return () => {
			clearInterval(tick);
			clearTimeout(auto);
		};
	});

	const transcribingLabel = $derived(isLongTranscribe ? 'Setting up' : 'Cancel');

	async function toggleVoice(): Promise<void> {
		if (!target || !supported) return;

		if (status === 'transcribing') {
			voiceStore.cancelTranscribing();
			return;
		}

		if (status === 'recording') {
			await voiceStore.stopAndSend(target);
			return;
		}

		await voiceStore.startRecording();
	}

	async function openMenu(): Promise<void> {
		try {
			devices = await listAudioInputs();
		} catch {
			devices = [];
		}
		menuOpen = true;
	}

	function canOpenMenu(): boolean {
		return status === 'idle' || status === 'error';
	}

	function handleContextMenu(e: MouseEvent): void {
		if (!canOpenMenu()) return;
		e.preventDefault();
		void openMenu();
	}

	function isHotkey(e: KeyboardEvent): boolean {
		return (
			e.code === 'Backquote' &&
			e.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		);
	}

	async function onWindowKeydown(e: KeyboardEvent): Promise<void> {
		if (e.repeat) return;
		if (!isHotkey(e)) return;
		e.preventDefault();
		await toggleVoice();
	}

	function formatElapsed(s: number): string {
		const m = Math.floor(s / 60);
		const r = s % 60;
		return `${m}:${r.toString().padStart(2, '0')}`;
	}

	const buttonTitle = $derived.by(() => {
		if (errorMsg) return errorMsg;
		if (status === 'transcribing')
			return isLongTranscribe
				? 'First-run setup. Tap or Ctrl+` to cancel.'
				: 'Tap or Ctrl+` to cancel transcription';
		if (status === 'recording') return 'Tap or Ctrl+` to stop';
		return 'Tap or Ctrl+` to record. Long-press or right-click for settings.';
	});

	function setLanguage(lang: VoiceLanguage): void {
		voiceStore.language = lang;
	}

	function setDevice(e: Event): void {
		const value = (e.target as HTMLSelectElement).value;
		voiceStore.deviceId = value || null;
	}

	function setAutoSubmit(checked: boolean | 'indeterminate'): void {
		voiceStore.autoSubmit = checked === true;
	}

	onMount(() => {
		if (!supported) return;
		window.addEventListener('keydown', onWindowKeydown);
	});

	onDestroy(() => {
		window.removeEventListener('keydown', onWindowKeydown);
	});
</script>

{#if supported}
	<div
		class="voice-btn-wrapper"
		oncontextmenu={handleContextMenu}
		role="presentation"
		use:longPress={{
			onTrigger: () => void openMenu(),
			enabled: canOpenMenu
		}}
		use:clickOutside={{
			enabled: () => menuOpen,
			onOutside: () => (menuOpen = false)
		}}
	>
		<Button
			{variant}
			size="toolbar"
			class="flex-1 voice-btn {status}"
			disabled={!target}
			onclick={() => void toggleVoice()}
			title={buttonTitle}
		>
			{#if status === 'transcribing'}
				<iconify-icon icon="mdi:loading" class="spin"></iconify-icon>
				<span>{transcribingLabel}</span>
			{:else if status === 'recording'}
				<iconify-icon icon="mdi:microphone"></iconify-icon>
				<span>{formatElapsed(elapsed)}</span>
			{:else if status === 'error'}
				<iconify-icon icon="mdi:microphone-off"></iconify-icon>
				<span>Mic</span>
			{:else}
				<iconify-icon icon="mdi:microphone"></iconify-icon>
				<span>Talk</span>
			{/if}
		</Button>

		{#if menuOpen}
			<div class="voice-menu">
				<div class="setting-row">
					<span class="setting-label">Language</span>
					<div class="lang-row">
						{#each ['auto', 'en', 'pt'] as const as lang}
							<Button
								variant={voiceStore.language === lang ? 'success' : 'secondary'}
								size="toolbar"
								class="flex-1"
								onclick={() => setLanguage(lang)}
							>
								{lang.toUpperCase()}
							</Button>
						{/each}
					</div>
				</div>

				<label class="setting-row inline">
					<Checkbox
						checked={voiceStore.autoSubmit}
						onCheckedChange={setAutoSubmit}
					/>
					<span class="setting-label inline">Auto-submit (Enter after transcript)</span>
				</label>

				<div class="setting-row">
					<label class="setting-label" for="voice-device">Microphone</label>
					<select
						id="voice-device"
						class="device-select"
						value={voiceStore.deviceId ?? ''}
						onchange={setDevice}
					>
						<option value="">System default</option>
						{#each devices as d (d.deviceId)}
							<option value={d.deviceId}>{d.label}</option>
						{/each}
					</select>
					{#if devices.length === 0}
						<p class="setting-hint">Allow mic access first to see device names.</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.voice-btn-wrapper {
		position: relative;
		display: flex;
		flex: 1;
	}

	:global(.voice-btn) {
		touch-action: none;
		user-select: none;
		width: 100%;
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

	.voice-menu {
		position: absolute;
		bottom: calc(100% + 6px);
		right: 0;
		width: 18rem;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 0.8rem;
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 6px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
		z-index: 50;
	}

	.setting-row {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.setting-row.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.setting-label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #aaa;
	}

	.setting-label.inline {
		text-transform: none;
		letter-spacing: normal;
		color: #ddd;
		font-size: 0.85rem;
	}

	.lang-row {
		display: flex;
		gap: 0.35rem;
	}

	.device-select {
		width: 100%;
		padding: 0.4rem 0.5rem;
		background: #222;
		color: #eee;
		border: 1px solid #444;
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.setting-hint {
		font-size: 0.7rem;
		color: #888;
		margin: 0;
	}
</style>
