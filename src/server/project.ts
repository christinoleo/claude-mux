/**
 * The project a session works in, as the side panel's Project pane shows it:
 * the repo root (else the session's cwd), the branch, and the prod/dev URLs
 * the repo names in `.claude-mux.json`, a file committed at its root so every
 * machine sees the same.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { currentBranch, repoRoot } from './git.js';

const PROJECT_CONFIG_FILE = '.claude-mux.json';

export interface ProjectConfig {
	/** Named URLs, e.g. `{ prod: 'https://…', dev: 'http://localhost:5173' }`. */
	urls: Record<string, string>;
	/** The project's icon: a path in the repo or an http(s) URL (`src/server/project-icons.ts`). */
	icon?: string;
}

export interface ProjectInfo {
	/** The repo root when the cwd is in one, else the cwd itself. */
	root: string;
	repo: boolean;
	branch: string | null;
	/** Null when the project has no `.claude-mux.json`. */
	config: ProjectConfig | null;
	/** Why `.claude-mux.json` could not be read, when it exists but is not usable. */
	configError: string | null;
}

/**
 * Read `.claude-mux.json`. `urls` keeps only string values that parse as
 * http(s) URLs, and `icon` only a non-empty string; anything else is dropped
 * rather than failing the whole file.
 */
export function parseProjectConfig(text: string): ProjectConfig {
	const raw: unknown = JSON.parse(text);
	const urls: Record<string, string> = {};
	if (raw && typeof raw === 'object' && 'urls' in raw) {
		const given = (raw as { urls: unknown }).urls;
		if (given && typeof given === 'object' && !Array.isArray(given)) {
			for (const [name, value] of Object.entries(given)) {
				if (typeof value !== 'string') continue;
				try {
					const { protocol } = new URL(value);
					if (protocol === 'http:' || protocol === 'https:') urls[name] = value;
				} catch {
					// not a URL
				}
			}
		}
	}
	const icon = raw && typeof raw === 'object' && 'icon' in raw ? (raw as { icon: unknown }).icon : undefined;
	return typeof icon === 'string' && icon.trim() ? { urls, icon: icon.trim() } : { urls };
}

export async function projectInfo(cwd: string): Promise<ProjectInfo> {
	const repo = await repoRoot(cwd);
	const root = repo ?? cwd;
	// The branch and the config do not depend on each other.
	const [branch, { config, configError }] = await Promise.all([
		repo ? currentBranch(repo) : null,
		readProjectConfig(root)
	]);
	return { root, repo: repo !== null, branch, config, configError };
}

/** The config at `root`: null with no error when the file is absent. */
export async function readProjectConfig(
	root: string
): Promise<Pick<ProjectInfo, 'config' | 'configError'>> {
	try {
		const config = parseProjectConfig(await readFile(join(root, PROJECT_CONFIG_FILE), 'utf-8'));
		return { config, configError: null };
	} catch (err) {
		const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
		return { config: null, configError: missing ? null : err instanceof Error ? err.message : String(err) };
	}
}
