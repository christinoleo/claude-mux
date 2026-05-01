import { browser } from '$app/environment';
import { VoiceRecorder, isVoiceSupported, type RecorderResult } from '$lib/voice/recorder';
import { createPersisted } from './persisted';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';
export type VoiceLanguage = 'auto' | 'en' | 'pt';

const MIN_UTTERANCE_MS = 200;

interface PersistedSettings {
	language: VoiceLanguage;
	autoSubmit: boolean;
	deviceId: string | null;
}

const persisted = createPersisted<PersistedSettings>('claude-mux-voice-settings', {
	language: 'auto',
	autoSubmit: false,
	deviceId: null
});

class VoiceStore {
	status = $state<VoiceStatus>('idle');
	error = $state<string | null>(null);
	startedAt = $state<number | null>(null);

	private prefs = $state<PersistedSettings>(persisted.load());
	private recorder: VoiceRecorder | null = null;
	private inflightAbort: AbortController | null = null;

	get supported(): boolean {
		return browser && isVoiceSupported();
	}

	get language(): VoiceLanguage {
		return this.prefs.language;
	}
	set language(v: VoiceLanguage) {
		if (this.prefs.language === v) return;
		this.prefs.language = v;
		persisted.save(this.prefs);
	}

	get autoSubmit(): boolean {
		return this.prefs.autoSubmit;
	}
	set autoSubmit(v: boolean) {
		if (this.prefs.autoSubmit === v) return;
		this.prefs.autoSubmit = v;
		persisted.save(this.prefs);
	}

	get deviceId(): string | null {
		return this.prefs.deviceId;
	}
	set deviceId(v: string | null) {
		if (this.prefs.deviceId === v) return;
		this.prefs.deviceId = v;
		persisted.save(this.prefs);
	}

	async startRecording(): Promise<void> {
		if (this.status === 'recording' || this.status === 'transcribing') return;
		if (!this.supported) {
			this.fail('Voice not supported in this browser');
			return;
		}

		try {
			if (!this.recorder) this.recorder = new VoiceRecorder();
			const result = await this.recorder.start(this.deviceId);
			if (result.fellBackToDefault && this.deviceId !== null) {
				// Saved device disappeared; clear so the picker reflects reality.
				this.deviceId = null;
			}
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

		if (result.blob.size === 0 || result.durationMs < MIN_UTTERANCE_MS) {
			this.status = 'idle';
			this.startedAt = null;
			return null;
		}

		this.status = 'transcribing';
		this.startedAt = null;

		const ac = new AbortController();
		this.inflightAbort = ac;

		const params = new URLSearchParams();
		if (this.language !== 'auto') params.set('lang', this.language);
		if (this.autoSubmit) params.set('submit', '1');
		const qs = params.toString();
		const url = `/api/sessions/${encodeURIComponent(target)}/voice${qs ? `?${qs}` : ''}`;

		try {
			const res = await fetch(url, {
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
			this.status = 'idle';
			return text;
		} catch (err) {
			if (ac.signal.aborted) {
				this.error = null;
				return null;
			}
			this.fail(err instanceof Error ? err.message : 'Transcription failed');
			return null;
		} finally {
			if (this.inflightAbort === ac) this.inflightAbort = null;
		}
	}

	cancelTranscribing(): void {
		if (this.status !== 'transcribing' || !this.inflightAbort) return;
		// Flip status synchronously so a follow-up startRecording() in the same tick
		// doesn't bail on the still-transcribing guard before the catch handler runs.
		this.status = 'idle';
		this.inflightAbort.abort();
	}

	private fail(message: string): void {
		this.status = 'error';
		this.error = message;
		this.startedAt = null;
	}
}

export const voiceStore = new VoiceStore();
