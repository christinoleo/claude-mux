import { browser } from '$app/environment';
import { VoiceRecorder, isVoiceSupported, type RecorderResult } from '$lib/voice/recorder';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';
export type VoiceLanguage = 'auto' | 'en' | 'pt';

const STORAGE_KEY = 'claude-mux-voice-settings';
const MIN_UTTERANCE_MS = 200;

interface PersistedSettings {
	language: VoiceLanguage;
	autoSubmit: boolean;
	deviceId: string | null;
}

const DEFAULTS: PersistedSettings = {
	language: 'auto',
	autoSubmit: false,
	deviceId: null
};

function loadSettings(): PersistedSettings {
	if (!browser) return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULTS };
		const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
		return { ...DEFAULTS, ...parsed };
	} catch {
		return { ...DEFAULTS };
	}
}

function saveSettings(settings: PersistedSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// quota exceeded or private browsing — settings won't persist this session
	}
}

class VoiceStore {
	status = $state<VoiceStatus>('idle');
	error = $state<string | null>(null);
	lastText = $state<string | null>(null);
	startedAt = $state<number | null>(null);

	private prefs = $state<PersistedSettings>(loadSettings());
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
		saveSettings(this.prefs);
	}

	get autoSubmit(): boolean {
		return this.prefs.autoSubmit;
	}
	set autoSubmit(v: boolean) {
		if (this.prefs.autoSubmit === v) return;
		this.prefs.autoSubmit = v;
		saveSettings(this.prefs);
	}

	get deviceId(): string | null {
		return this.prefs.deviceId;
	}
	set deviceId(v: string | null) {
		if (this.prefs.deviceId === v) return;
		this.prefs.deviceId = v;
		saveSettings(this.prefs);
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
			this.lastText = text;
			this.status = 'idle';
			return text;
		} catch (err) {
			if (ac.signal.aborted) {
				this.status = 'idle';
				this.error = null;
				this.lastText = null;
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
