const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

export type WhisperModelName =
	| "whisper-large-v3"
	| "whisper-large-v3-turbo"
	| "distil-whisper-large-v3-en";

const DEFAULT_MODEL: WhisperModelName = "whisper-large-v3-turbo";

export interface TranscribeOptions {
	model?: WhisperModelName;
	language?: string;
	mime?: string;
	signal?: AbortSignal;
}

export async function transcribeAudio(
	audio: Buffer,
	opts: TranscribeOptions = {}
): Promise<string> {
	const apiKey = process.env.GROQ_API_KEY;
	if (!apiKey) {
		throw new Error(
			"GROQ_API_KEY not set. Get a key at https://console.groq.com/keys and export GROQ_API_KEY=..."
		);
	}

	const model = opts.model ?? DEFAULT_MODEL;
	const filename = `audio.${pickExtension(opts.mime)}`;

	const form = new FormData();
	form.append(
		"file",
		new Blob([new Uint8Array(audio)], { type: opts.mime || "audio/webm" }),
		filename
	);
	form.append("model", model);
	form.append("response_format", "text");
	if (opts.language && opts.language !== "auto") {
		form.append("language", opts.language);
	}

	const res = await fetch(GROQ_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal: opts.signal
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`Groq transcription failed (${res.status}): ${detail.slice(0, 500)}`);
	}

	const text = await res.text();
	return text.trim();
}

function pickExtension(mime: string | undefined): string {
	if (!mime) return "webm";
	if (mime.includes("webm")) return "webm";
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("wav")) return "wav";
	if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
	if (mime.includes("mpeg")) return "mp3";
	if (mime.includes("flac")) return "flac";
	return "webm";
}
