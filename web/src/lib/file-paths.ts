/**
 * Telling a file path from the rest of a message. A path may carry a line
 * (`src/tmux/pane.ts:120`, `:120:5`, `:120-140`), which is split off. What
 * counts as a path is decided by its last part being a file's name, so
 * that `and/or`, `origin/main`, `/api/sessions` and `v0.30.8` stay prose.
 */

export interface FilePath {
	path: string;
	line: number | null;
}

/** A path found in a run of text, with where it sits. */
export interface FilePathHit extends FilePath {
	start: number;
	end: number;
}

/** A path's trailing `:line`, `:line:col` or `:from-to`. */
const LINE = String.raw`:(\d+)(?::\d+)?(?:-\d+)?`;
const LINE_SUFFIX = new RegExp(`${LINE}$`);

/** The characters a path is made of; brackets, parentheses and `+` for SvelteKit's routes. */
const PATH_CHARS = /^[\w.@+~$()[\]/-]+$/;

/** The extensions a file's name ends in. An open list would take `owner/repo.git` and `release-1.x` for files. */
const EXTENSIONS = new Set(
	(
		'ts mts cts tsx js mjs cjs jsx svelte vue astro html htm xml svg css scss less json jsonl jsonc ' +
		'md mdx markdown rst txt py rb php java kt swift cs c h cc cpp hpp rs go lua sh bash zsh fish ' +
		'yml yaml toml ini cfg conf lock csv tsv sql diff patch ' +
		'png jpg jpeg gif webp ico pdf ipynb proto graphql tf nix service'
	).split(' ')
);

/** File names that carry no extension. */
const BARE_NAMES = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'Procfile', 'Gemfile', 'Rakefile', 'Justfile']);

/** Dotfiles, by how their name starts: `.env.local`, `.eslintrc.cjs`. Any other `.word` is a property or a CSS class. */
const DOTFILE =
	/^\.(?:env|gitignore|gitattributes|gitmodules|dockerignore|npmrc|nvmrc|editorconfig|eslintrc|eslintignore|prettierrc|prettierignore|bashrc|zshrc|profile)(?:\.[\w.-]+)?$/;

/** A first part that names a host, as in `github.com/owner/repo/a.ts`. */
const HOST = /^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|ai|app|co)$/i;

/** Whether a path's last part is a file's name. */
function namesFile(name: string): boolean {
	if (BARE_NAMES.has(name) || DOTFILE.test(name)) return true;
	const ext = /[\w)\]]\.([A-Za-z][A-Za-z0-9]*)$/.exec(name)?.[1];
	return ext !== undefined && EXTENSIONS.has(ext.toLowerCase());
}

/**
 * The path and line `text` is, or null when it is something else. With
 * `needDirectory` a bare file name is not enough, which is how plain prose is
 * read: there `Node.js` is a name, not a file.
 */
export function parseFilePath(text: string, needDirectory = false): FilePath | null {
	const suffix = LINE_SUFFIX.exec(text);
	const path = suffix ? text.slice(0, suffix.index) : text;
	if (!path || path.length > 400 || !PATH_CHARS.test(path)) return null;
	if (path.startsWith('//') || path.endsWith('/')) return null;
	const parts = path.split('/');
	const inDirectory = parts.length > 1;
	if (needDirectory && !inDirectory) return null;
	if (inDirectory && HOST.test(parts[0])) return null;
	if (!namesFile(parts[parts.length - 1])) return null;
	return { path, line: suffix ? Number(suffix[1]) || null : null };
}

/**
 * Something shaped like a path with a directory in it, not starting inside a
 * word, a URL or another path. Parentheses are left out, since in prose they
 * are far more often around a path than in one. The second lookbehind skips a
 * start inside a run of `+`, which the start before it has already covered:
 * without it a long run with no `/` is scanned once from every `+` in it.
 */
const IN_PROSE = new RegExp(
	String.raw`(?<![\w@.~/:$[\]-])(?<!\+(?=[\w.@+$[\]-]))(?:~\/|\.{1,2}\/|\/)?[\w.@+$[\]-]+(?:\/[\w.@+$[\]-]+)+(?:${LINE})?`,
	'g'
);

/** The file paths in a run of plain text, in order, with where each sits. */
export function findFilePaths(text: string): FilePathHit[] {
	const found: FilePathHit[] = [];
	for (const m of text.matchAll(IN_PROSE)) {
		// The full stop that ends a sentence is not the path's.
		const candidate = m[0].replace(/\.+$/, '');
		const hit = parseFilePath(candidate, true);
		if (hit) found.push({ ...hit, start: m.index, end: m.index + candidate.length });
	}
	return found;
}
