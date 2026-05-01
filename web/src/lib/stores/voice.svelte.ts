import { browser } from '$app/environment';
import { VoiceRecorder, isVoiceSupported, type RecorderResult } from '$lib/voice/recorder';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';

interface State {
	status: VoiceStatus;
	error: string | null;
	lastText: string | null;
	startedAt: number | null;
}

class VoiceStore {
	private state = $state<State>({
		status: 'idle',
		error: null,
		lastText: null,
		startedAt: null
	});

	private recorder: VoiceRecorder | null = null;

	get status(): VoiceStatus {
		return this.state.status;
	}

	get error(): string | null {
		return this.state.error;
	}

	get lastText(): string | null {
		return this.state.lastText;
	}

	get startedAt(): number | null {
		return this.state.startedAt;
	}

	get supported(): boolean {
		return browser && isVoiceSupported();
	}

	async startRecording(): Promise<void> {
		if (this.state.status !== 'idle') return;
		if (!this.supported) {
			this.fail('Voice not supported in this browser');
			return;
		}

		try {
			if (!this.recorder) this.recorder = new VoiceRecorder();
			await this.recorder.start();
			this.state.status = 'recording';
			this.state.error = null;
			this.state.startedAt = Date.now();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Microphone access denied');
		}
	}

	async stopAndSend(target: string): Promise<string | null> {
		if (this.state.status !== 'recording' || !this.recorder) return null;

		let result: RecorderResult;
		try {
			result = await this.recorder.stop();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Recording failed');
			return null;
		}

		if (result.blob.size === 0 || result.durationMs < 200) {
			this.state.status = 'idle';
			this.state.startedAt = null;
			return null;
		}

		this.state.status = 'transcribing';
		this.state.startedAt = null;

		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(target)}/voice`, {
				method: 'POST',
				headers: { 'Content-Type': result.mimeType },
				body: result.blob
			});

			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(body || `HTTP ${res.status}`);
			}

			const data = (await res.json()) as { text?: string };
			const text = data.text ?? '';
			this.state.lastText = text;
			this.state.status = 'idle';
			return text;
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Transcription failed');
			return null;
		}
	}

	cancel(): void {
		this.recorder?.cancel();
		this.state.status = 'idle';
		this.state.startedAt = null;
	}

	clearError(): void {
		if (this.state.status === 'error') {
			this.state.status = 'idle';
		}
		this.state.error = null;
	}

	dispose(): void {
		this.recorder?.dispose();
		this.recorder = null;
	}

	private fail(message: string): void {
		this.state.status = 'error';
		this.state.error = message;
		this.state.startedAt = null;
	}
}

export const voiceStore = new VoiceStore();
