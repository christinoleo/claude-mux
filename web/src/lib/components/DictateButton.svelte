<script lang="ts" module>
	let made = 0;
</script>

<script lang="ts">
	import { voiceStore } from '$lib/stores/voice.svelte';

	interface Props {
		/** The session the words are for; it says where spoken slash commands are looked up. */
		target: string;
		/** Given what was said, to put in the field this button sits beside. */
		onText: (text: string) => void;
		disabled?: boolean;
	}

	let { target, onText, disabled = false }: Props = $props();

	/**
	 * A microphone for one field. The composer's records straight into the
	 * session; this one only fills the field beside it, to be read, edited and
	 * sent with the rest of the form. There is one microphone on the page, so
	 * while another field or the composer has it this button waits.
	 */
	const field = `field-${++made}`;
	const mine = $derived(voiceStore.isOwnedBy(target, field));
	const status = $derived(mine ? voiceStore.status : 'idle');
	const elsewhere = $derived(voiceStore.isActive && !mine);
	const label = $derived(
		status === 'recording'
			? 'Stop and write what you said here'
			: status === 'transcribing'
				? 'Transcribing. Tap to cancel'
				: elsewhere
					? 'The microphone is in use'
					: 'Answer by voice'
	);

	async function toggle() {
		if (status === 'transcribing') return voiceStore.cancelTranscribing();
		if (status === 'recording') {
			const said = await voiceStore.stop();
			if (said) onText(said.text);
			return;
		}
		await voiceStore.startRecording(target, field);
	}
</script>

{#if voiceStore.supported}
	<button
		type="button"
		class="dictate {status}"
		disabled={disabled || elsewhere}
		aria-label={label}
		title={label}
		aria-pressed={status === 'recording'}
		onclick={() => void toggle()}
	>
		{#if status === 'transcribing'}
			<iconify-icon icon="mdi:loading" class="spin"></iconify-icon>
		{:else if status === 'recording'}
			<iconify-icon icon="mdi:stop"></iconify-icon>
		{:else}
			<iconify-icon icon="mdi:microphone"></iconify-icon>
		{/if}
	</button>
{/if}

<style>
	.dictate {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border: 1px solid #292524;
		border-radius: 8px;
		background: transparent;
		color: #a8a29e;
		font-size: 18px;
		cursor: pointer;
		touch-action: manipulation;
	}
	.dictate:hover:not(:disabled) {
		color: #e7e5e4;
		border-color: #44403c;
	}
	.dictate:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.dictate.recording {
		border-color: #dc2626;
		background: rgba(220, 38, 38, 0.18);
		color: #fca5a5;
	}
	@media (pointer: coarse) {
		.dictate {
			width: 40px;
			height: 40px;
		}
	}
	.dictate:focus-visible {
		outline: 2px solid #78716c;
		outline-offset: 1px;
	}
</style>
