import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { nodewhisper } from "nodejs-whisper";
import { VOICE_MODELS_DIR, VOICE_TMP_DIR } from "../../utils/paths.js";

export type WhisperModelName =
	| "tiny"
	| "tiny.en"
	| "base"
	| "base.en"
	| "small"
	| "small.en"
	| "medium"
	| "medium.en"
	| "large-v3-turbo";

const DEFAULT_MODEL: WhisperModelName = "base.en";

mkdirSync(VOICE_MODELS_DIR, { recursive: true });
mkdirSync(VOICE_TMP_DIR, { recursive: true });

const TIMESTAMP_LINE = /^\[\d\d:\d\d:\d\d\.\d{3}\s-->\s\d\d:\d\d:\d\d\.\d{3}\]\s+/;

function stripTimestamps(raw: string): string {
	return raw
		.split("\n")
		.map((line) => line.replace(TIMESTAMP_LINE, "").trim())
		.filter(Boolean)
		.join(" ")
		.trim();
}

export interface TranscribeOptions {
	model?: WhisperModelName;
	language?: string;
	mime?: string;
}

export async function transcribeAudio(
	audio: Buffer,
	opts: TranscribeOptions = {}
): Promise<string> {
	const model = opts.model ?? DEFAULT_MODEL;
	const ext = pickExtension(opts.mime);
	const tmpPath = join(VOICE_TMP_DIR, `${randomUUID()}.${ext}`);
	writeFileSync(tmpPath, audio);

	try {
		const raw = await nodewhisper(tmpPath, {
			modelName: model,
			autoDownloadModelName: model,
			modelRootPath: VOICE_MODELS_DIR,
			removeWavFileAfterTranscription: true,
			whisperOptions: {
				outputInText: true,
				language: opts.language ?? (model.endsWith(".en") ? "en" : "auto")
			}
		});
		return stripTimestamps(raw);
	} finally {
		try {
			unlinkSync(tmpPath);
		} catch {
			// already gone
		}
	}
}

function pickExtension(mime: string | undefined): string {
	if (!mime) return "webm";
	if (mime.includes("webm")) return "webm";
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("wav")) return "wav";
	if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
	if (mime.includes("mpeg")) return "mp3";
	return "webm";
}
