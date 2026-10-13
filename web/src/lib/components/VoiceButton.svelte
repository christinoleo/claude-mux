<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { longPress } from '$lib/actions/longPress';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { voiceStore, type VoiceLanguage } from '$lib/stores/voice.svelte';
	import { listAudioInputs, type AudioInputDevice } from '$lib/voice/recorder';

	interface Props {
		target: string | null;
		/**
		 * The tap. The composer owns the take and what becomes of the words, so
		 * this button, the hotkey and the gamepad all go through its one toggle.
		 */
		onToggle: () => void;
	}

	let { target, onToggle }: Props = $props();

	const supported = $derived(voiceStore.supported);
	// Voice is a single-mic singleton owned by the page that started it; non-owner
	// pages render as idle so stray clicks/hotkeys/Esc can't hijack it.
	const isOwner = $derived(voiceStore.isOwnedBy(target));
	const busyElsewhere = $derived(voiceStore.isActive && !isOwner);
	const status = $derived(isOwner ? voiceStore.status : 'idle');
	const errorMsg = $derived(isOwner ? voiceStore.error : null);

	const MAX_RECORDING_MS = 10 * 60 * 1000;
	const LONG_TRANSCRIBE_MS = 5000;

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

	// A take left running is stopped, and kept, before it outgrows what one upload carries.
	$effect(() => {
		if (status !== 'recording') return;
		const auto = setTimeout(toggleVoice, MAX_RECORDING_MS);
		return () => clearTimeout(auto);
	});

	function toggleVoice(): void {
		if (!busyElsewhere && target) onToggle();
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
		return !busyElsewhere && (status === 'idle' || status === 'error');
	}

	function handleContextMenu(e: MouseEvent): void {
		if (!canOpenMenu()) return;
		e.preventDefault();
		void openMenu();
	}

	const buttonTitle = $derived.by(() => {
		if (busyElsewhere) {
			return `Voice ${voiceStore.status} on ${voiceStore.ownerTarget}. Switch to that session to control it.`;
		}
		if (errorMsg) return errorMsg;
		if (status === 'transcribing')
			return isLongTranscribe
				? 'First-run setup. ✕ or Esc to cancel.'
				: 'Transcribing. ✕ or Esc to cancel.';
		if (status === 'recording')
			return 'Tap or F2/Pause/Ctrl+` to stop. ✕ or Esc to discard.';
		return 'Tap or focus input then F2/Pause/Ctrl+` to record. Long-press or right-click for settings.';
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

	function setGain(e: Event): void {
		const value = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isNaN(value)) voiceStore.gain = value;
	}

	function setNoiseSuppression(checked: boolean | 'indeterminate'): void {
		voiceStore.noiseSuppression = checked === true;
	}

	function showUnsupportedReason(): void {
		const reason = voiceStore.unsupportedReason ?? 'Voice not supported.';
		alert(reason);
	}
</script>

<div
	class="voice-btn-wrapper round"
	oncontextmenu={supported ? handleContextMenu : undefined}
	role="presentation"
	use:longPress={{
		onTrigger: () => void openMenu(),
		enabled: () => supported && canOpenMenu()
	}}
	use:clickOutside={{
		enabled: menuOpen,
		onOutside: () => (menuOpen = false)
	}}
>
	{#if !supported}
		<Button
			variant="secondary"
			size="toolbar"
			class="flex-1 voice-btn unsupported"
			onclick={showUnsupportedReason}
			title={voiceStore.unsupportedReason ?? 'Voice not supported'}
		>
			<iconify-icon icon="mdi:microphone-off"></iconify-icon>
			<span>Mic</span>
		</Button>
	{:else}
		<button
			type="button"
			class="voice-round {status}"
			disabled={!target || busyElsewhere}
			onclick={() => void toggleVoice()}
			title={buttonTitle}
			aria-label={buttonTitle}
		>
			{#if busyElsewhere}
				<iconify-icon icon="mdi:microphone-off"></iconify-icon>
			{:else if status === 'transcribing'}
				<iconify-icon icon="mdi:loading" class="spin"></iconify-icon>
			{:else if status === 'error'}
				<iconify-icon icon="mdi:microphone-off"></iconify-icon>
			{:else}
				<iconify-icon icon="mdi:microphone"></iconify-icon>
			{/if}
		</button>
	{/if}

		{#if menuOpen}
			<div class="voice-menu">
				<button
					type="button"
					class="voice-menu-close"
					aria-label="Close settings"
					onclick={() => (menuOpen = false)}
				>
					<iconify-icon icon="mdi:close"></iconify-icon>
				</button>
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
					<span class="setting-label inline">Send when the recording stops</span>
				</label>

				<div class="setting-row">
					<label class="setting-label" for="voice-gain">
						Gain &times;{voiceStore.gain.toFixed(1)}
					</label>
					<input
						id="voice-gain"
						type="range"
						min="1"
						max="6"
						step="0.5"
						value={voiceStore.gain}
						oninput={setGain}
						class="gain-slider"
					/>
					<p class="setting-hint">Boost quiet voice. Higher = louder + more noise.</p>
				</div>

				<label class="setting-row inline">
					<Checkbox
						checked={voiceStore.noiseSuppression}
						onCheckedChange={setNoiseSuppression}
					/>
					<span class="setting-label inline">Noise suppression (off helps very quiet speech)</span>
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

<style>
	.voice-btn-wrapper {
		position: relative;
		display: flex;
		flex: 1;
	}

	.voice-btn-wrapper.round {
		flex: none;
		width: 42px;
		height: 42px;
	}

	.voice-round {
		width: 42px;
		height: 42px;
		border-radius: 50%;
		border: 1px solid #333;
		background: #222;
		color: #f5f5f4;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 19px;
		cursor: pointer;
		touch-action: none;
		user-select: none;
		/* punches the rail's channel out of the panel behind it */
		box-shadow: 0 0 0 4px #111;
	}
	.voice-round:hover:not(:disabled) {
		background: #333;
	}
	.voice-round:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.voice-round.recording,
	.voice-round.error {
		background: #b91c1c;
		border-color: #b91c1c;
		color: #fff;
	}

	:global(.voice-btn) {
		touch-action: none;
		user-select: none;
		width: 100%;
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
		z-index: var(--z-floating);
	}

	.voice-menu-close {
		position: absolute;
		top: 0.3rem;
		right: 0.3rem;
		width: 1.6rem;
		height: 1.6rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 0;
		border-radius: 4px;
		color: #aaa;
		font-size: 1rem;
		cursor: pointer;
		padding: 0;
	}

	.voice-menu-close:hover {
		background: #2a2a2a;
		color: #eee;
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

	.gain-slider {
		width: 100%;
		accent-color: #84cc16;
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
