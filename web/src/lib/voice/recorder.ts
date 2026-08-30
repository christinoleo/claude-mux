export interface RecorderResult {
	blob: Blob;
	mimeType: string;
	durationMs: number;
}

const PREFERRED_MIME = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/ogg;codecs=opus',
	'audio/mp4'
];

function pickMimeType(): string {
	if (typeof MediaRecorder === 'undefined') return '';
	for (const m of PREFERRED_MIME) {
		if (MediaRecorder.isTypeSupported(m)) return m;
	}
	return '';
}

export interface AudioLevel {
	rms: number;
	peak: number;
}

export interface RecorderStartOptions {
	gain?: number;
	noiseSuppression?: boolean;
}

export class VoiceRecorder {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;
	private pending: { resolve: (r: RecorderResult) => void; reject: (e: Error) => void } | null =
		null;
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private timeBuf: Float32Array<ArrayBuffer> | null = null;
	private gainNode: GainNode | null = null;

	async start(
		deviceId?: string | null,
		opts: RecorderStartOptions = {}
	): Promise<{ fellBackToDefault: boolean }> {
		if (this.recorder && this.recorder.state === 'recording') {
			throw new Error('Already recording');
		}

		const gain = Math.max(0.1, Math.min(10, opts.gain ?? 1));
		const useGainStage = gain !== 1;
		const noiseSuppression = opts.noiseSuppression ?? true;

		const audio: MediaTrackConstraints = {
			echoCancellation: true,
			noiseSuppression,
			autoGainControl: true
		};
		if (deviceId) audio.deviceId = { exact: deviceId };

		let fellBackToDefault = false;
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio });
		} catch (err) {
			if (deviceId && err instanceof Error && err.name === 'OverconstrainedError') {
				delete audio.deviceId;
				this.stream = await navigator.mediaDevices.getUserMedia({ audio });
				fellBackToDefault = true;
			} else {
				throw err;
			}
		}

		// Build WebAudio graph: source -> [gain] -> analyser (for meter) and -> destination (for recorder).
		// When gain == 1 we still split to attach the analyser, but skip the synthetic destination
		// so the recorder consumes the original mic stream directly (lower CPU, no resampling).
		let recordStream: MediaStream = this.stream;
		try {
			const Ctor =
				window.AudioContext ??
				(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (Ctor) {
				this.audioCtx = new Ctor();
				const source = this.audioCtx.createMediaStreamSource(this.stream);
				const analyser = this.audioCtx.createAnalyser();
				analyser.fftSize = 1024;
				analyser.smoothingTimeConstant = 0.4;

				if (useGainStage) {
					const gainNode = this.audioCtx.createGain();
					gainNode.gain.value = gain;
					const dest = this.audioCtx.createMediaStreamDestination();
					source.connect(gainNode);
					gainNode.connect(analyser);
					gainNode.connect(dest);
					this.gainNode = gainNode;
					recordStream = dest.stream;
				} else {
					source.connect(analyser);
				}

				this.analyser = analyser;
				this.timeBuf = new Float32Array(analyser.fftSize);
			}
		} catch {
			this.audioCtx = null;
			this.analyser = null;
			this.timeBuf = null;
			this.gainNode = null;
			recordStream = this.stream;
		}

		const mimeType = pickMimeType();
		const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
		this.recorder = new MediaRecorder(recordStream, options);
		this.chunks = [];
		this.startedAt = performance.now();

		this.recorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) this.chunks.push(e.data);
		};

		this.recorder.onstop = () => {
			const used = this.recorder?.mimeType || mimeType || 'audio/webm';
			const blob = new Blob(this.chunks, { type: used });
			const durationMs = performance.now() - this.startedAt;
			this.releaseStream();
			this.pending?.resolve({ blob, mimeType: used, durationMs });
			this.pending = null;
		};

		this.recorder.onerror = (ev) => {
			const err =
				(ev as unknown as { error?: Error }).error ??
				new Error('MediaRecorder error');
			this.releaseStream();
			this.pending?.reject(err);
			this.pending = null;
		};

		this.recorder.start();
		return { fellBackToDefault };
	}

	async stop(): Promise<RecorderResult> {
		const rec = this.recorder;
		if (!rec || rec.state === 'inactive') {
			throw new Error('Not recording');
		}

		return new Promise<RecorderResult>((resolve, reject) => {
			this.pending = { resolve, reject };
			rec.stop();
		});
	}

	getLevel(): AudioLevel | null {
		if (!this.analyser || !this.timeBuf) return null;
		this.analyser.getFloatTimeDomainData(this.timeBuf);
		let sumSq = 0;
		let peak = 0;
		for (let i = 0; i < this.timeBuf.length; i++) {
			const v = this.timeBuf[i];
			sumSq += v * v;
			const a = v < 0 ? -v : v;
			if (a > peak) peak = a;
		}
		const rms = Math.sqrt(sumSq / this.timeBuf.length);
		return { rms, peak };
	}

	private releaseStream(): void {
		if (this.stream) {
			for (const t of this.stream.getTracks()) t.stop();
			this.stream = null;
		}
		if (this.audioCtx) {
			void this.audioCtx.close().catch(() => {});
			this.audioCtx = null;
		}
		this.analyser = null;
		this.timeBuf = null;
		this.gainNode = null;
	}
}

export function isVoiceSupported(): boolean {
	return voiceUnsupportedReason() === null;
}

export function voiceUnsupportedReason(): string | null {
	if (typeof navigator === 'undefined') return 'No navigator (SSR).';
	if (typeof window !== 'undefined' && window.isSecureContext === false) {
		return 'Voice requires HTTPS or localhost. Open this page over HTTPS.';
	}
	if (!navigator.mediaDevices?.getUserMedia) {
		return 'Browser blocks microphone access. Open over HTTPS or use a supported browser.';
	}
	if (typeof MediaRecorder === 'undefined') {
		return 'MediaRecorder API unavailable in this browser.';
	}
	if (pickMimeType() === '') {
		return 'No supported audio codec (webm/ogg/mp4). Try another browser.';
	}
	return null;
}

export interface AudioInputDevice {
	deviceId: string;
	label: string;
}

export async function listAudioInputs(): Promise<AudioInputDevice[]> {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
		return [];
	}
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices
		.filter((d) => d.kind === 'audioinput')
		.map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
}
