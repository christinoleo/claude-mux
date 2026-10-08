/**
 * What the Changes pane draws, worked out from what the changes API returns:
 * which files fold away as generated, the letter each file's status gets, and
 * a file's hunks as the rows of a unified diff, line numbers and all.
 */

/** A hunk as the API sends it: its `@@` header and unified-diff lines. */
export interface Hunk {
	header: string;
	lines: string[];
}

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
		let oldLine = m ? Number(m[1]) : null;
		let newLine = m ? Number(m[3]) : null;
		if (oldLine !== null) {
			// A hunk that only adds to an empty file starts at 0.
			const start = Math.max(oldLine, 1);
			if (start > nextOld) rows.push({ type: 'gap', count: start - nextOld });
			nextOld = start + Number(m![2] ?? 1);
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
