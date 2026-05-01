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

export class VoiceRecorder {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;
	private pending: { resolve: (r: RecorderResult) => void; reject: (e: Error) => void } | null =
		null;

	async start(): Promise<void> {
		if (this.recorder && this.recorder.state === 'recording') {
			throw new Error('Already recording');
		}

		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});

		const mimeType = pickMimeType();
		const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
		this.recorder = new MediaRecorder(this.stream, options);
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

	cancel(): void {
		if (this.recorder && this.recorder.state !== 'inactive') {
			this.recorder.onstop = null;
			this.recorder.onerror = null;
			try {
				this.recorder.stop();
			} catch {
				// ignore
			}
		}
		this.releaseStream();
		this.pending?.reject(new Error('Cancelled'));
		this.pending = null;
		this.chunks = [];
		this.recorder = null;
	}

	private releaseStream(): void {
		if (!this.stream) return;
		for (const t of this.stream.getTracks()) t.stop();
		this.stream = null;
	}
}

export function isVoiceSupported(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof MediaRecorder !== 'undefined' &&
		pickMimeType() !== ''
	);
}
