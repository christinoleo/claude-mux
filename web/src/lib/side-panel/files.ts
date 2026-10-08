/**
 * The Files pane's pure half: what the API answers, which Shiki grammar a
 * path reads as, quick-open's fuzzy match, and the file and line a
 * transcript tool row points at.
 */
import type { PatchHunk } from '$shared/transcript/parser.js';
import type { FileRead as ServerFileRead } from '$shared/server/files.js';

export type { FileEntry, DirListing } from '$shared/server/files.js';

/** What the read route answers with 200; a binary file answers 415. */
export type FileRead = Exclude<ServerFileRead, { kind: 'binary' }>;

/** The Shiki grammar for a path, or null to draw it plain. */
export function shikiLanguage(path: string): string | null {
	const name = path.split('/').pop() ?? '';
	if (/^Dockerfile/.test(name)) return 'docker';
	if (name === 'Makefile') return 'make';
	if (name.startsWith('.') && !name.slice(1).includes('.')) return DOTFILES[name] ?? null;
	const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
	return LANGUAGES[ext] ?? null;
}

const DOTFILES: Record<string, string> = {
	'.gitignore': 'shellscript',
	'.env': 'shellscript',
	'.bashrc': 'shellscript',
	'.zshrc': 'shellscript'
};

const LANGUAGES: Record<string, string> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'tsx',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'jsx',
	svelte: 'svelte',
	html: 'html',
	xml: 'xml',
	svg: 'xml',
	css: 'css',
	scss: 'scss',
	json: 'json',
	jsonl: 'json',
	jsonc: 'jsonc',
	md: 'markdown',
	py: 'python',
	sh: 'shellscript',
	bash: 'shellscript',
	zsh: 'shellscript',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'toml',
	rs: 'rust',
	go: 'go',
	sql: 'sql',
	diff: 'diff',
	patch: 'diff'
};

export function isMarkdown(path: string): boolean {
	return /\.(md|markdown)$/i.test(path);
}

/** The directories that hold `path`, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function ancestors(path: string): string[] {
	const parts = path.split('/').slice(0, -1);
	return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * How well `query` matches `path`: null for no match, else higher is better.
 * Every query character must appear in order; runs of consecutive characters,
 * matches at a word start, and matches in the file name score more, and a
 * shorter path wins a tie. Each place the first character occurs is tried as
 * a start, so `cli` finds `cli.ts` rather than the `c` of `src`.
 */
export function fuzzyScore(query: string, path: string): number | null {
	const q = query.toLowerCase().replace(/\s+/g, '');
	if (!q) return 0;
	const p = path.toLowerCase();
	let best: number | null = null;
	for (let start = p.indexOf(q[0]); start !== -1; start = p.indexOf(q[0], start + 1)) {
		const score = scoreFrom(q, p, path, start);
		if (score === null) break;
		if (best === null || score > best) best = score;
	}
	return best === null ? null : best - path.length * 0.01;
}

/** The score of matching `q` greedily in `p` with its first character at `start`. */
function scoreFrom(q: string, p: string, path: string, start: number): number | null {
	const nameStart = path.lastIndexOf('/') + 1;
	let score = 0;
	let at = start - 1;
	let run = 0;
	for (const ch of q) {
		const next = p.indexOf(ch, at + 1);
		if (next === -1) return null;
		run = next === at + 1 ? run + 1 : 0;
		score += 1 + run * 2;
		const prev = path[next - 1];
		if (next === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.') score += 3;
		if (next >= nameStart) score += 2;
		at = next;
	}
	return score;
}

/** The best `limit` paths for `query`, best first. */
export function fuzzyFilter(query: string, paths: readonly string[], limit = 50): string[] {
	const scored: { path: string; score: number }[] = [];
	for (const path of paths) {
		const score = fuzzyScore(query, path);
		if (score !== null) scored.push({ path, score });
	}
	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((s) => s.path);
}

/** The tools whose row can open the file it touched in the Files pane. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The first changed line a hunk lands on in the new file. */
function firstChangedLine(hunk: PatchHunk): number | null {
	const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk.header);
	if (!m) return null;
	let line = Number(m[1]);
	for (const l of hunk.lines) {
		if (l.startsWith('+')) return line;
		if (!l.startsWith('-')) line++;
	}
	return Number(m[1]);
}

/**
 * The file a transcript tool row touched and the line to open it at: a Read's
 * offset, or the first line an edit changed. Null for any other tool.
 */
export function toolFileTarget(entry: {
	name: string;
	input: string;
	patch?: { file: string; hunks: PatchHunk[] };
}): { path: string; line: number | null } | null {
	if (!FILE_TOOLS.has(entry.name)) return null;
	let input: Record<string, unknown> = {};
	try {
		input = JSON.parse(entry.input);
	} catch {
		// cut off by the parser's limit: the path is near the front, try for it alone
		const m = /"(?:file_path|notebook_path)":\s*"((?:[^"\\]|\\.)*)"/.exec(entry.input);
		if (m) input = { file_path: JSON.parse(`"${m[1]}"`) };
	}
	const path =
		entry.patch?.file ||
		(typeof input.file_path === 'string' ? input.file_path : null) ||
		(typeof input.notebook_path === 'string' ? input.notebook_path : null);
	if (!path) return null;
	if (entry.name === 'Read') {
		const offset = Number(input.offset);
		return { path, line: Number.isInteger(offset) && offset > 0 ? offset : null };
	}
	const hunk = entry.patch?.hunks[0];
	return { path, line: hunk ? firstChangedLine(hunk) : null };
}
