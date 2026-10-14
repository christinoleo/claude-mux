import { browser } from '$app/environment';
import {
	VoiceRecorder,
	isVoiceSupported,
	voiceUnsupportedReason,
	type RecorderResult
} from '$lib/voice/recorder';
import { createPersisted } from './persisted';
import { sessionApi } from './fleet.svelte';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';
export type VoiceLanguage = 'auto' | 'en' | 'pt';

const MIN_UTTERANCE_MS = 200;

/** What a take came to: the words, and whether they resolved to a slash command. */
export interface Dictation {
	text: string;
	command: boolean;
}

interface PersistedSettings {
	language: VoiceLanguage;
	autoSubmit: boolean;
	deviceId: string | null;
	gain: number;
	noiseSuppression: boolean;
}

const persisted = createPersisted<PersistedSettings>('claude-mux-voice-settings', {
	language: 'auto',
	autoSubmit: true,
	deviceId: null,
	gain: 1,
	noiseSuppression: true
});

class VoiceStore {
	status = $state<VoiceStatus>('idle');
	error = $state<string | null>(null);
	startedAt = $state<number | null>(null);
	level = $state<{ rms: number; peak: number }>({ rms: 0, peak: 0 });
	/** The session a take is for, as a ref: its target here, `host@target` on another machine. */
	ownerTarget = $state<string | null>(null);
	/**
	 * Which field of that session asked for the take: null for the composer,
	 * otherwise the id a question's own microphone gave itself. Only the field
	 * that started a take may stop it, since the words are its to receive.
	 */
	ownerField = $state<string | null>(null);

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

	isOwnedBy(target: string | null, field: string | null = null): boolean {
		return target != null && this.ownerTarget === target && this.ownerField === field;
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

	async startRecording(target: string, field: string | null = null): Promise<void> {
		if (this.isActive) return;
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
			this.ownerField = field;
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

	/**
	 * End the take and resolve with what was said, or null when there is
	 * nothing to show for it (too short, cancelled, or failed, in which case
	 * `error` says why). The words are the caller's to place: this store
	 * records and transcribes, and delivers nothing.
	 */
	async stop(): Promise<Dictation | null> {
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
			this.release();
			return null;
		}

		this.status = 'transcribing';
		this.startedAt = null;

		const ac = new AbortController();
		this.inflightAbort = ac;
		const qs = this.language === 'auto' ? '' : `?lang=${this.language}`;

		try {
			const api = sessionApi(target);
			if (!api) throw new Error('Not a session');
			const res = await fetch(`${api}/voice${qs}`, {
				method: 'POST',
				headers: { 'Content-Type': result.mimeType },
				body: result.blob,
				signal: ac.signal
			});

			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(body || `HTTP ${res.status}`);
			}

			const data = (await res.json()) as { text?: string; command?: boolean };
			this.release();
			const text = (data.text ?? '').trim();
			return text ? { text, command: data.command === true } : null;
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

	private release(): void {
		this.status = 'idle';
		this.startedAt = null;
		this.ownerTarget = null;
		this.ownerField = null;
	}

	cancelTranscribing(): void {
		if (this.status !== 'transcribing' || !this.inflightAbort) return;
		// Flip status synchronously so a follow-up startRecording() in the same tick
		// doesn't bail on the still-transcribing guard before the catch handler runs.
		this.release();
		this.inflightAbort.abort();
	}

	private async cancelRecording(): Promise<void> {
		if (this.status !== 'recording' || !this.recorder) return;
		this.release();
		this.stopLevelLoop();
		try {
			await this.recorder.stop();
		} catch {
			// recorder already torn down; nothing to do
		}
	}

	async cancel(): Promise<void> {
		if (this.status === 'recording') {
			await this.cancelRecording();
		} else if (this.status === 'transcribing') {
			this.cancelTranscribing();
		}
	}

	private fail(message: string): void {
		this.release();
		this.status = 'error';
		this.error = message;
	}
}

export const voiceStore = new VoiceStore();
