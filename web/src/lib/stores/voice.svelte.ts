import { browser } from '$app/environment';
import { VoiceRecorder, isVoiceSupported, type RecorderResult } from '$lib/voice/recorder';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';

class VoiceStore {
	status = $state<VoiceStatus>('idle');
	error = $state<string | null>(null);
	lastText = $state<string | null>(null);
	startedAt = $state<number | null>(null);

	private recorder: VoiceRecorder | null = null;
	private inflightAbort: AbortController | null = null;

	get supported(): boolean {
		return browser && isVoiceSupported();
	}

	async startRecording(): Promise<void> {
		if (this.status === 'recording' || this.status === 'transcribing') return;
		if (!this.supported) {
			this.fail('Voice not supported in this browser');
			return;
		}

		try {
			if (!this.recorder) this.recorder = new VoiceRecorder();
			await this.recorder.start();
			this.status = 'recording';
			this.error = null;
			this.startedAt = Date.now();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Microphone access denied');
		}
	}

	async stopAndSend(target: string): Promise<string | null> {
		if (this.status !== 'recording' || !this.recorder) return null;

		let result: RecorderResult;
		try {
			result = await this.recorder.stop();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Recording failed');
			return null;
		}

		if (result.blob.size === 0 || result.durationMs < 200) {
			this.status = 'idle';
			this.startedAt = null;
			return null;
		}

		this.status = 'transcribing';
		this.startedAt = null;

		const ac = new AbortController();
		this.inflightAbort = ac;

		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(target)}/voice`, {
				method: 'POST',
				headers: { 'Content-Type': result.mimeType },
				body: result.blob,
				signal: ac.signal
			});

			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(body || `HTTP ${res.status}`);
			}

			const data = (await res.json()) as { text?: string };
			const text = data.text ?? '';
			this.lastText = text;
			this.status = 'idle';
			return text;
		} catch (err) {
			if (ac.signal.aborted) {
				this.status = 'idle';
				this.error = null;
				return null;
			}
			this.fail(err instanceof Error ? err.message : 'Transcription failed');
			return null;
		} finally {
			if (this.inflightAbort === ac) this.inflightAbort = null;
		}
	}

	cancel(): void {
		this.recorder?.cancel();
		this.status = 'idle';
		this.startedAt = null;
	}

	cancelTranscribing(): void {
		if (this.status !== 'transcribing' || !this.inflightAbort) return;
		this.inflightAbort.abort();
	}

	private fail(message: string): void {
		this.status = 'error';
		this.error = message;
		this.startedAt = null;
	}
}

export const voiceStore = new VoiceStore();
