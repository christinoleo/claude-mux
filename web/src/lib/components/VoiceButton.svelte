<script lang="ts">
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

	const transcribingLabel = $derived(isLongTranscribe ? 'Setting up' : 'Working');

	async function toggleVoice(): Promise<void> {
		if (target) await voiceStore.toggle(target);
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

	function formatElapsed(s: number): string {
		const m = Math.floor(s / 60);
		const r = s % 60;
		return `${m}:${r.toString().padStart(2, '0')}`;
	}

	const buttonTitle = $derived.by(() => {
		if (errorMsg) return errorMsg;
		if (status === 'transcribing')
			return isLongTranscribe
				? 'First-run setup. ✕ or Esc to cancel.'
				: 'Transcribing. ✕ or Esc to cancel.';
		if (status === 'recording')
			return 'Tap or F2/Pause/Ctrl+` to send. ✕ or Esc to discard.';
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
	class="voice-btn-wrapper"
	oncontextmenu={supported ? handleContextMenu : undefined}
	role="presentation"
	use:longPress={{
		onTrigger: () => void openMenu(),
		enabled: () => supported && canOpenMenu()
	}}
	use:clickOutside={{
		enabled: () => menuOpen,
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
	{/if}

	{#if voiceStore.isActive}
			<button
				type="button"
				class="voice-cancel"
				aria-label="Cancel voice"
				title="Discard recording / transcription"
				onclick={() => void voiceStore.cancel()}
			>
				<iconify-icon icon="mdi:close"></iconify-icon>
				<span>Discard</span>
			</button>
		{/if}

		{#if status === 'recording'}
			{@const rms = voiceStore.level.rms}
			{@const peak = voiceStore.level.peak}
			{@const fillPct = Math.min(100, Math.round(rms * 220))}
			{@const tooSoft = peak < 0.04}
			{@const clipping = peak >= 0.98}
			<div
				class="voice-meter"
				class:too-soft={tooSoft}
				class:clipping={clipping}
				title={clipping ? 'Clipping — too loud' : tooSoft ? 'Too soft — speak louder or boost gain' : `Level ${(rms * 100).toFixed(0)}%`}
			>
				<div class="voice-meter-fill" style="width: {fillPct}%"></div>
			</div>
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
					<span class="setting-label inline">Auto-submit (Enter after transcript)</span>
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

	.voice-meter {
		position: absolute;
		left: 6px;
		right: 26px;
		bottom: 3px;
		height: 4px;
		background: rgba(255, 255, 255, 0.12);
		border-radius: 2px;
		overflow: hidden;
		pointer-events: none;
	}

	.voice-meter-fill {
		height: 100%;
		background: linear-gradient(90deg, #16a34a 0%, #84cc16 60%, #facc15 85%, #dc2626 100%);
		transition: width 60ms linear;
	}

	.voice-meter.too-soft .voice-meter-fill {
		background: #6b7280;
	}

	.voice-meter.clipping {
		background: rgba(220, 38, 38, 0.4);
		animation: voice-meter-clip 0.4s ease-in-out infinite;
	}

	@keyframes voice-meter-clip {
		0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.6); }
		50% { box-shadow: 0 0 0 2px rgba(220, 38, 38, 0); }
	}

	.voice-cancel {
		position: absolute;
		bottom: calc(100% + 10px);
		right: 0;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 6px 14px;
		background: #1a1a1a;
		color: #fca5a5;
		border: 1px solid rgba(220, 38, 38, 0.55);
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: rgba(220, 38, 38, 0.3);
		box-shadow:
			0 6px 18px rgba(0, 0, 0, 0.4),
			0 0 0 1px rgba(220, 38, 38, 0.15);
		z-index: 20;
		white-space: nowrap;
		animation: voice-cancel-rise 180ms cubic-bezier(0.2, 0.9, 0.2, 1);
	}

	.voice-cancel iconify-icon {
		font-size: 1.05rem;
	}

	.voice-cancel::after {
		content: '';
		position: absolute;
		top: 100%;
		right: 18px;
		width: 8px;
		height: 8px;
		background: #1a1a1a;
		border-right: 1px solid rgba(220, 38, 38, 0.55);
		border-bottom: 1px solid rgba(220, 38, 38, 0.55);
		transform: translateY(-5px) rotate(45deg);
	}

	.voice-cancel:hover,
	.voice-cancel:active,
	.voice-cancel:focus-visible {
		background: #dc2626;
		color: #fff;
		border-color: #dc2626;
		outline: none;
	}

	.voice-cancel:hover::after,
	.voice-cancel:active::after,
	.voice-cancel:focus-visible::after {
		background: #dc2626;
		border-color: #dc2626;
	}

	@keyframes voice-cancel-rise {
		from {
			opacity: 0;
			transform: translateY(6px) scale(0.96);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
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
