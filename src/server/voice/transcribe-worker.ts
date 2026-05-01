#!/usr/bin/env bun

import { nodewhisper } from "nodejs-whisper";

const TRANSCRIPT_DELIM = "---CLAUDE-MUX-TRANSCRIPT---";

async function main(): Promise<void> {
	const [tmpPath, model, language, modelRoot, withCuda] = process.argv.slice(2);

	if (!tmpPath || !model || !modelRoot) {
		process.stderr.write("Usage: transcribe-worker <audioPath> <model> <language> <modelRoot> <withCuda>\n");
		process.exit(2);
	}

	try {
		const raw = await nodewhisper(tmpPath, {
			modelName: model,
			autoDownloadModelName: model,
			modelRootPath: modelRoot,
			removeWavFileAfterTranscription: true,
			withCuda: withCuda === "1",
			whisperOptions: {
				outputInText: true,
				language: language || "auto"
			}
		});

		process.stdout.write(`${TRANSCRIPT_DELIM}\n`);
		process.stdout.write(raw ?? "");
		process.exit(0);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`worker error: ${message}\n`);
		process.exit(1);
	}
}

void main();
