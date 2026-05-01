import { existsSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const LEGACY_CLAUDE_WATCH_DIR = join(homedir(), ".claude-watch");
export const CLAUDE_MUX_DIR = join(homedir(), ".claude-mux");
export const SESSIONS_DIR = join(CLAUDE_MUX_DIR, "sessions");
export const CONFIG_PATH = join(CLAUDE_MUX_DIR, "config.json");
export const VOICE_DIR = join(CLAUDE_MUX_DIR, "voice");
export const VOICE_MODELS_DIR = join(VOICE_DIR, "models");
export const VOICE_TMP_DIR = join(VOICE_DIR, "tmp");

export const CLAUDE_DIR = join(homedir(), ".claude");
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

export const DEFAULT_SERVER_PORT = 3456;

let migrationAttempted = false;

export function migrateLegacyDataDir(): boolean {
	if (migrationAttempted) return false;
	migrationAttempted = true;
	if (!existsSync(LEGACY_CLAUDE_WATCH_DIR) || existsSync(CLAUDE_MUX_DIR)) {
		return false;
	}
	try {
		renameSync(LEGACY_CLAUDE_WATCH_DIR, CLAUDE_MUX_DIR);
		console.log(`[claude-mux] Migrated ${LEGACY_CLAUDE_WATCH_DIR} → ${CLAUDE_MUX_DIR}`);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[claude-mux] Failed to migrate legacy data dir: ${msg}`);
		return false;
	}
}
