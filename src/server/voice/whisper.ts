import { spawn, spawnSync } from "child_process";
import {
	mkdirSync,
	writeFileSync,
	unlinkSync,
	readFileSync,
	rmSync,
	existsSync
} from "fs";
import { writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { VOICE_DIR, VOICE_MODELS_DIR, VOICE_TMP_DIR } from "../../utils/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const WORKER_TS = join(__dirname, "transcribe-worker.ts");
const WORKER_JS = join(__dirname, "transcribe-worker.js");
const WORKER_PATH = existsSync(WORKER_TS) ? WORKER_TS : WORKER_JS;
const TRANSCRIPT_DELIM = "---CLAUDE-MUX-TRANSCRIPT---";

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

type BuildFlavor = "cuda" | "cpu";

function detectCudaToolkit(): boolean {
	try {
		const smi = spawnSync("nvidia-smi", ["-L"], { stdio: "ignore" });
		if (smi.status !== 0) return false;
		const nvcc = spawnSync("nvcc", ["--version"], { stdio: "ignore" });
		return nvcc.status === 0;
	} catch {
		return false;
	}
}

const CUDA_AVAILABLE = detectCudaToolkit();
const ACTIVE_FLAVOR: BuildFlavor = CUDA_AVAILABLE ? "cuda" : "cpu";

const DEFAULT_MODEL: WhisperModelName = CUDA_AVAILABLE ? "large-v3-turbo" : "small";

mkdirSync(VOICE_MODELS_DIR, { recursive: true });
mkdirSync(VOICE_TMP_DIR, { recursive: true });

reconcileBuildFlavor();

function reconcileBuildFlavor(): void {
	const flavorFile = join(VOICE_DIR, "build-flavor.json");
	let previous: BuildFlavor | null = null;
	try {
		if (existsSync(flavorFile)) {
			const data = JSON.parse(readFileSync(flavorFile, "utf-8")) as { flavor?: string };
			if (data.flavor === "cuda" || data.flavor === "cpu") previous = data.flavor;
		}
	} catch {
		// ignore corrupt flavor file
	}

	if (previous === ACTIVE_FLAVOR) return;

	const buildDir = locateWhisperBuildDir();
	if (buildDir && existsSync(buildDir)) {
		try {
			rmSync(buildDir, { recursive: true, force: true });
			console.log(
				`[claude-mux voice] Cleared whisper.cpp build (was ${previous ?? "unknown"}, now ${ACTIVE_FLAVOR})`
			);
		} catch (err) {
			console.warn(`[claude-mux voice] Failed to clear build dir: ${err}`);
		}
	}

	try {
		writeFileSync(flavorFile, JSON.stringify({ flavor: ACTIVE_FLAVOR }, null, 2));
	} catch {
		// non-fatal: rebuild logic still works on next start
	}
}

function locateWhisperBuildDir(): string | null {
	try {
		const require = createRequire(import.meta.url);
		const main = require.resolve("nodejs-whisper");
		return join(dirname(main), "..", "cpp", "whisper.cpp", "build");
	} catch {
		return null;
	}
}

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
	signal?: AbortSignal;
}

export async function transcribeAudio(
	audio: Buffer,
	opts: TranscribeOptions = {}
): Promise<string> {
	const model = opts.model ?? DEFAULT_MODEL;
	const language = opts.language ?? (model.endsWith(".en") ? "en" : "auto");
	const ext = pickExtension(opts.mime);
	const tmpPath = join(VOICE_TMP_DIR, `${randomUUID()}.${ext}`);
	await writeFile(tmpPath, audio);

	try {
		const raw = await runWorker(tmpPath, model, language, opts.signal);
		return stripTimestamps(raw);
	} finally {
		try {
			unlinkSync(tmpPath);
		} catch {
			// already gone
		}
	}
}

interface ActiveWorker {
	pid: number;
	cleanup: () => void;
}

const activeWorkers = new Set<ActiveWorker>();
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER_BYTES = 1 << 20;

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

async function runWorker(
	audioPath: string,
	model: string,
	language: string,
	signal?: AbortSignal
): Promise<string> {
	if (signal?.aborted) throw new Error("Aborted");

	const proc = spawn(
		"bun",
		[WORKER_PATH, audioPath, model, language, VOICE_MODELS_DIR, CUDA_AVAILABLE ? "1" : "0"],
		{
			cwd: PROJECT_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
			// Own process group so we can kill grandchildren (cmake, whisper-cli, ffmpeg)
			// via `process.kill(-pid, signal)` if the request is aborted.
			detached: true
		}
	);

	const pid = proc.pid ?? 0;

	let killed = false;
	const cleanup = (): void => {
		if (killed || pid === 0) return;
		killed = true;
		killGroup(pid, "SIGTERM");
		setTimeout(() => killGroup(pid, "SIGKILL"), 5000).unref();
	};

	const entry: ActiveWorker = { pid, cleanup };
	activeWorkers.add(entry);

	const onAbort = (): void => cleanup();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(cleanup, WORKER_TIMEOUT_MS);

	let stdoutBuf = "";
	let stderrBuf = "";
	const append = (current: string, chunk: Buffer): string => {
		const next = current + chunk.toString("utf-8");
		// Keep only the tail; transcript marker is near the end of stdout, errors at end of stderr.
		return next.length > MAX_BUFFER_BYTES ? next.slice(next.length - MAX_BUFFER_BYTES) : next;
	};
	proc.stdout?.on("data", (chunk: Buffer) => {
		stdoutBuf = append(stdoutBuf, chunk);
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderrBuf = append(stderrBuf, chunk);
	});

	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			proc.once("error", reject);
			proc.once("close", (code) => resolve(code ?? -1));
		});

		if (signal?.aborted) throw new Error("Aborted");

		if (exitCode !== 0) {
			throw new Error(stderrBuf.trim() || `transcribe-worker exited with code ${exitCode}`);
		}

		const idx = stdoutBuf.indexOf(`${TRANSCRIPT_DELIM}\n`);
		if (idx < 0) {
			throw new Error("transcribe-worker produced no transcript");
		}
		return stdoutBuf.slice(idx + TRANSCRIPT_DELIM.length + 1);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		activeWorkers.delete(entry);
	}
}

function shutdownWorkers(): void {
	for (const w of activeWorkers) w.cleanup();
	activeWorkers.clear();
}

process.on("SIGINT", shutdownWorkers);
process.on("SIGTERM", shutdownWorkers);
process.on("SIGHUP", shutdownWorkers);
process.on("exit", shutdownWorkers);

if (import.meta.hot) {
	import.meta.hot.dispose(shutdownWorkers);
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
