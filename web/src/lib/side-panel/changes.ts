/**
 * What the Changes pane draws, worked out from what the changes API returns:
 * which files fold away as generated, the letter each file's status gets, and
 * a file's hunks as the rows of a unified diff, line numbers and all.
 */

import type { PatchHunk } from '$shared/transcript/parser.js';
import type { TurnChanges } from '$shared/transcript/changes.js';
import type { GitDiff } from '$shared/server/git.js';

/** A hunk as the API sends it: its `@@` header and unified-diff lines. */
export type Hunk = PatchHunk;

export type Source = 'git' | 'session';

/** One file in the list, from either source. */
export interface ChangedFile {
	file: string;
	kind: 'added' | 'modified' | 'deleted' | 'renamed';
	oldPath?: string;
	untracked?: boolean;
	binary?: boolean;
	additions: number;
	deletions: number;
}

/** A turn of the session source, its files read as the list reads any file. */
export type Turn = Omit<TurnChanges, 'files'> & { files: ChangedFile[] };

/** What `/changes` answers: the files, and from the session source its turns too. */
export interface Listing {
	source: Source;
	root?: string;
	files: ChangedFile[];
	turns?: Turn[];
	/** From the session source: the prompt that opens every turn, changed something or not. */
	prompts?: string[];
	totals: { files: number; additions: number; deletions: number };
}

/** What the transcript needs to draw each turn's change summary. */
export interface TranscriptChanges {
	turns: Turn[];
	prompts: ReadonlySet<string>;
	/** Where the changed paths are shown relative to. */
	root: string | null;
}

/** What `/changes/diff` answers, from either source. */
export type Diff = GitDiff;

/** Line totals over a list of files. */
export function sumCounts(files: readonly { additions: number; deletions: number }[]) {
	let additions = 0;
	let deletions = 0;
	for (const f of files) {
		additions += f.additions;
		deletions += f.deletions;
	}
	return { additions, deletions };
}

/**
 * Paths a person rarely reads in a diff: lockfiles, build output, minified
 * and generated code, snapshots. The list folds them under "N generated".
 */
const GENERATED: RegExp[] = [
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/,
	/(^|\/)(Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|flake\.lock|mix\.lock|pubspec\.lock|Podfile\.lock)$/,
	/(^|\/)(dist|build|out|coverage|node_modules|vendor|\.svelte-kit|\.next|\.nuxt|__generated__)\//,
	/\.min\.(js|css)$/,
	/\.(map|snap)$/,
	/(^|\/)__snapshots__\//,
	/[._-]generated\.[^/]+$/,
	/\.(pb|gen)\.[^/]+$/
];

export function isGenerated(path: string): boolean {
	return GENERATED.some((re) => re.test(path));
}

/** The letter a file's status shows as, the way `git status --short` writes it. */
export function statusLetter(f: ChangedFile): 'A' | 'M' | 'D' | 'R' | '?' {
	if (f.untracked) return '?';
	return f.kind === 'added' ? 'A' : f.kind === 'deleted' ? 'D' : f.kind === 'renamed' ? 'R' : 'M';
}

/** A path as the list shows it: relative to `root` when it sits under it. */
export function displayPath(path: string, root: string | null): string {
	if (!root || !path.startsWith('/')) return path;
	const base = root.endsWith('/') ? root : `${root}/`;
	return path.startsWith(base) ? path.slice(base.length) : path;
}

export type DiffRow =
	| { type: 'hunk'; header: string }
	| { type: 'gap'; count: number }
	| { type: 'context' | 'add' | 'del'; old: number | null; new: number | null; text: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A file's hunks as the rows a unified diff draws: each hunk's header, its
 * lines with the old and new line numbers they sit at, and between hunks a
 * row counting the unchanged lines left out. Lines before the first hunk are
 * counted too; after the last, the file's length is not known, so nothing is.
 */
export function diffRows(hunks: Hunk[]): DiffRow[] {
	const rows: DiffRow[] = [];
	let nextOld = 1;
	for (const hunk of hunks) {
		const m = HUNK_HEADER.exec(hunk.header);
		let oldLine: number | null = null;
		let newLine: number | null = null;
		if (m) {
			oldLine = Number(m[1]);
			newLine = Number(m[3]);
			// A hunk that removes no lines names the line it inserts after.
			const oldCount = Number(m[2] ?? 1);
			const start = oldCount === 0 ? oldLine + 1 : oldLine;
			if (start > nextOld) rows.push({ type: 'gap', count: start - nextOld });
			nextOld = start + oldCount;
		}
		rows.push({ type: 'hunk', header: hunk.header });
		for (const line of hunk.lines) {
			const sign = line[0];
			const text = line.slice(1);
			if (sign === '+') {
				rows.push({ type: 'add', old: null, new: newLine, text });
				if (newLine !== null) newLine++;
			} else if (sign === '-') {
				rows.push({ type: 'del', old: oldLine, new: null, text });
				if (oldLine !== null) oldLine++;
			} else if (sign === '\\') {
				// "\ No newline at end of file" says something about the line above.
				continue;
			} else {
				rows.push({ type: 'context', old: oldLine, new: newLine, text });
				if (oldLine !== null) oldLine++;
				if (newLine !== null) newLine++;
			}
		}
	}
	return rows;
}

/** The highlight.js language a path's extension names, or null to leave it plain. */
export function languageFor(path: string): string | null {
	const name = path.split('/').pop() ?? '';
	if (/^Dockerfile/.test(name)) return 'dockerfile';
	if (name === 'Makefile') return 'makefile';
	const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
	return LANGUAGES[ext] ?? null;
}

const LANGUAGES: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	svelte: 'xml',
	vue: 'xml',
	html: 'xml',
	xml: 'xml',
	svg: 'xml',
	css: 'css',
	scss: 'scss',
	json: 'json',
	jsonl: 'json',
	md: 'markdown',
	py: 'python',
	sh: 'bash',
	bash: 'bash',
	zsh: 'bash',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'ini',
	ini: 'ini',
	rs: 'rust',
	go: 'go',
	sql: 'sql',
	java: 'java',
	kt: 'kotlin',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	hpp: 'cpp',
	rb: 'ruby',
	php: 'php',
	swift: 'swift',
	lua: 'lua'
};

/**
 * Where each turn's change summary goes in the transcript: after the last
 * item of the turn, keyed by that item's id. A turn runs from its prompt to
 * the next one, and only the ids in `prompts` count as prompts: the transcript
 * also draws user lines the log does not open a turn on (a steer that rode in
 * with a tool result, say), and those fall inside the turn around them. A turn
 * whose prompt is not among the items, scrolled out above the loaded tail,
 * gets no summary, and neither does the last turn while `open`, the session
 * still working on it.
 */
export function placeTurnChanges(
	items: readonly { id: string; kind: string }[],
	turns: readonly Turn[],
	prompts: ReadonlySet<string>,
	open: boolean
): Map<string, Turn> {
	const byPrompt = new Map<string, Turn>();
	for (const t of turns) if (t.id) byPrompt.set(t.id, t);
	const placed = new Map<string, Turn>();
	let current: Turn | null = null;
	let last: string | null = null;
	for (const item of items) {
		if (item.kind === 'user' && prompts.has(item.id)) {
			if (current && last) placed.set(last, current);
			current = byPrompt.get(item.id) ?? null;
		}
		last = item.id;
	}
	if (current && last && !open) placed.set(last, current);
	return placed;
}
