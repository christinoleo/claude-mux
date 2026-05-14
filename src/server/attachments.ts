/**
 * Helpers for composing prompt text that includes user-uploaded attachments.
 *
 * Attachments are referenced via Claude Code's `@/path` syntax. Paths must
 * live under the session's attachments dir to prevent the web API being used
 * to feed Claude arbitrary host paths (see docs/adr/0001).
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { getSessionAttachmentsDir } from '../db/index.js';

/**
 * Validate that every path lives under the session's attachments dir AND
 * exists on disk. Returns the resolved absolute paths in input order, or
 * an error string.
 */
export function validateAttachmentPaths(
	sessionId: string,
	paths: string[]
): { ok: true; paths: string[] } | { ok: false; error: string } {
	const root = resolve(getSessionAttachmentsDir(sessionId)) + '/';
	const out: string[] = [];
	for (const p of paths) {
		if (typeof p !== 'string' || !p) {
			return { ok: false, error: 'attachment path must be a non-empty string' };
		}
		const resolved = resolve(p);
		if (!resolved.startsWith(root)) {
			return { ok: false, error: 'attachment path outside session dir' };
		}
		if (!existsSync(resolved)) {
			return { ok: false, error: `attachment not found: ${resolved}` };
		}
		out.push(resolved);
	}
	return { ok: true, paths: out };
}

/**
 * Build a single `@`-prefixed token for a path, quoting if it contains
 * characters that would break Claude Code's `@path` tokenizer (spaces,
 * tabs). Single quotes used because Claude Code accepts `@'…'` for paths
 * with spaces.
 */
function token(path: string): string {
	if (/\s/.test(path)) {
		const escaped = path.replace(/'/g, `'\\''`);
		return `@'${escaped}'`;
	}
	return `@${path}`;
}

/**
 * Compose the final string fed to tmux: attachment tokens followed by
 * user text. Always single-space-separated; works for single- or
 * multi-line text. Empty text + attachments → tokens only.
 */
export function composePromptWithAttachments(text: string, paths: string[]): string {
	if (paths.length === 0) return text;
	const tokens = paths.map(token).join(' ');
	if (!text) return tokens;
	return `${tokens} ${text}`;
}
