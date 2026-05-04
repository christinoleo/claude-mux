import { browser } from '$app/environment';
import {
	VoiceRecorder,
	isVoiceSupported,
	voiceUnsupportedReason,
	type RecorderResult
} from '$lib/voice/recorder';
import { createPersisted } from './persisted';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';
export type VoiceLanguage = 'auto' | 'en' | 'pt';

const MIN_UTTERANCE_MS = 200;

interface PersistedSettings {
	language: VoiceLanguage;
	autoSubmit: boolean;
	deviceId: string | null;
	gain: number;
	noiseSuppression: boolean;
}

const persisted = createPersisted<PersistedSettings>('claude-mux-voice-settings', {
	language: 'auto',
	autoSubmit: false,
	deviceId: null,
	gain: 1,
	noiseSuppression: true
});

class VoiceStore {
	status = $state<VoiceStatus>('idle');
	error = $state<string | null>(null);
	startedAt = $state<number | null>(null);
	level = $state<{ rms: number; peak: number }>({ rms: 0, peak: 0 });
	ownerTarget = $state<string | null>(null);

	private prefs = $state<PersistedSettings>(persisted.load());
	private recorder: VoiceRecorder | null = null;
	private inflightAbort: AbortController | null = null;
	private levelRaf: number | null = null;

	get supported(): boolean {
		return browser && isVoiceSupported();
	}

	get unsupportedReason(): string | null {
		if (!browser) return null;
		return voiceUnsupportedReason();
	}

	get isActive(): boolean {
		return this.status === 'recording' || this.status === 'transcribing';
	}

	isOwnedBy(target: string | null): boolean {
		return target != null && this.ownerTarget === target;
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

	get gain(): number {
		return this.prefs.gain;
	}
	set gain(v: number) {
		const clamped = Math.max(0.1, Math.min(10, v));
		if (this.prefs.gain === clamped) return;
		this.prefs.gain = clamped;
		persisted.save(this.prefs);
	}

	get noiseSuppression(): boolean {
		return this.prefs.noiseSuppression;
	}
	set noiseSuppression(v: boolean) {
		if (this.prefs.noiseSuppression === v) return;
		this.prefs.noiseSuppression = v;
		persisted.save(this.prefs);
	}

	async startRecording(target: string): Promise<void> {
		if (this.status === 'recording' || this.status === 'transcribing') return;
		if (!this.supported) {
			this.fail('Voice not supported in this browser');
			return;
		}
		if (!target) {
			this.fail('No target for voice recording');
			return;
		}

		try {
			if (!this.recorder) this.recorder = new VoiceRecorder();
			const result = await this.recorder.start(this.deviceId, {
				gain: this.gain,
				noiseSuppression: this.noiseSuppression
			});
			if (result.fellBackToDefault && this.deviceId !== null) {
				// Saved device disappeared; clear so the picker reflects reality.
				this.deviceId = null;
			}
			this.ownerTarget = target;
			this.status = 'recording';
			this.error = null;
			this.startedAt = Date.now();
			this.startLevelLoop();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Microphone access denied');
		}
	}

	private startLevelLoop(): void {
		this.stopLevelLoop();
		const tick = (): void => {
			if (this.status !== 'recording' || !this.recorder) {
				this.levelRaf = null;
				return;
			}
			const lvl = this.recorder.getLevel();
			if (lvl) this.level = lvl;
			this.levelRaf = requestAnimationFrame(tick);
		};
		this.levelRaf = requestAnimationFrame(tick);
	}

	private stopLevelLoop(): void {
		if (this.levelRaf !== null) {
			cancelAnimationFrame(this.levelRaf);
			this.levelRaf = null;
		}
		this.level = { rms: 0, peak: 0 };
	}

	async stopAndSend(submit = this.autoSubmit): Promise<string | null> {
		if (this.status !== 'recording' || !this.recorder) return null;
		const target = this.ownerTarget;
		if (!target) {
			// Should never happen — ownerTarget is set in lockstep with status='recording'.
			this.fail('Voice owner missing');
			return null;
		}

		this.stopLevelLoop();
		let result: RecorderResult;
		try {
			result = await this.recorder.stop();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Recording failed');
			return null;
		}

		// Cancel may have flipped status to idle while we awaited recorder.stop().
		if (this.status !== 'recording') return null;

		if (result.blob.size === 0 || result.durationMs < MIN_UTTERANCE_MS) {
			this.status = 'idle';
			this.startedAt = null;
			this.ownerTarget = null;
			return null;
		}

		this.status = 'transcribing';
		this.startedAt = null;

		const params = new URLSearchParams();
		if (this.language !== 'auto') params.set('lang', this.language);
		if (submit) params.set('submit', '1');

		const ac = new AbortController();
		this.inflightAbort = ac;
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
			this.ownerTarget = null;
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
		this.ownerTarget = null;
		this.inflightAbort.abort();
	}

	async cancelRecording(): Promise<void> {
		if (this.status !== 'recording' || !this.recorder) return;
		this.status = 'idle';
		this.startedAt = null;
		this.ownerTarget = null;
		this.stopLevelLoop();
		try {
			await this.recorder.stop();
		} catch {
			// recorder already torn down; nothing to do
		}
	}

	async toggle(target: string): Promise<void> {
		if (!this.supported) return;
		// Cross-target toggles are no-ops: a different page must not steal an
		// in-flight recording or transcription owned by another session.
		if (this.isActive && this.ownerTarget !== target) return;
		if (this.status === 'transcribing') {
			this.cancelTranscribing();
			return;
		}
		if (this.status === 'recording') {
			await this.stopAndSend();
			return;
		}
		await this.startRecording(target);
	}

	async cancel(): Promise<void> {
		if (this.status === 'recording') {
			await this.cancelRecording();
		} else if (this.status === 'transcribing') {
			this.cancelTranscribing();
		}
	}

	async stopAndSubmit(): Promise<string | null> {
		return this.stopAndSend(true);
	}

	private fail(message: string): void {
		this.status = 'error';
		this.error = message;
		this.startedAt = null;
		this.ownerTarget = null;
	}
}

export const voiceStore = new VoiceStore();
