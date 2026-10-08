/**
 * Read-only access to the files of the project a session works in, for the
 * side panel's Files pane: one directory at a time, one file at a time, and
 * the repo's file list for quick-open.
 *
 * The root is the session's repo (`git_root`, else the work tree its cwd sits
 * in), or the cwd itself outside a repo. Every path a caller names is resolved
 * with `realpath` and refused unless it lands inside the root's own realpath,
 * so neither `..` nor a symlink that points out of the project can reach
 * anything else. `.git` is never listed or read.
 */

import { execFile } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { realpath, readdir, readFile, stat, open } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { Session } from '../db/sessions-json.js';
import { git, repoRoot } from './git.js';
import { imageMimeFor } from '../utils/image-types.js';

/** Text past this many bytes is cut off, and the answer says so. */
export const READ_LIMIT_BYTES = 1024 * 1024;
/** Images past this size are refused. */
const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
/** How much of a file is sniffed for a NUL byte to call it binary. */
const SNIFF_BYTES = 8 * 1024;
/** The most paths quick-open is handed. */
const LIST_LIMIT = 50_000;

export interface FileEntry {
	name: string;
	/** Relative to the root, `/`-separated. */
	path: string;
	type: 'dir' | 'file';
	/** git ignores it; listed only when ignored entries are asked for. */
	ignored?: true;
	/** A symlink (that stays inside the root). */
	link?: true;
}

export interface DirListing {
	root: string;
	/** The directory listed, relative to the root ('' for the root itself). */
	dir: string;
	repo: boolean;
	entries: FileEntry[];
	/** How many ignored entries were left out. */
	hidden: number;
}

export type FileRead =
	| {
			kind: 'text';
			path: string;
			size: number;
			/** The bytes of the file `text` holds, short of `size` when truncated. */
			shown: number;
			text: string;
			truncated: boolean;
	}
	| { kind: 'image'; path: string; size: number; mime: string }
	| { kind: 'binary'; path: string; size: number };

/** A path the guard refused, or one that is not there; `status` is the HTTP answer. */
export class FileAccessError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

/** The directory the Files pane is rooted at for a session. */
export async function filesRoot(session: Pick<Session, 'cwd' | 'git_root'>): Promise<{ root: string; repo: boolean }> {
	const repo = session.git_root ?? (await repoRoot(session.cwd));
	return { root: repo ?? session.cwd, repo: repo !== null };
}

function isInside(root: string, abs: string): boolean {
	const rel = relative(root, abs);
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** A `.git` directory at any depth (a submodule's, a vendored repo's) or anything in one. */
function isGitPath(rel: string): boolean {
	return rel.split('/').includes('.git');
}

/**
 * Resolve `path` (relative to `root`, or absolute) to a real path inside the
 * root. An absolute path is taken as given, so one that names the root through
 * another spelling (a symlink to it) still resolves. Throws a 403 for a path
 * that lands outside the root or in `.git`, and a 404 for one that is not there.
 */
export async function resolveInRoot(
	root: string,
	path: string
): Promise<{ abs: string; rel: string; realRoot: string }> {
	if (path.includes('\0')) throw new FileAccessError('Invalid path', 400);
	const realRoot = await realpath(root).catch(() => {
		throw new FileAccessError('Project directory not found', 404);
	});
	const wanted = isAbsolute(path) ? resolve(path) : resolve(realRoot, path);
	// Refuse a path that climbs out before touching the disk, so its existence is not told.
	if (!isInside(realRoot, wanted) && !(isAbsolute(path) && isInside(resolve(root), wanted))) {
		throw new FileAccessError('Path is outside the project', 403);
	}
	let abs: string;
	try {
		abs = await realpath(wanted);
	} catch {
		throw new FileAccessError('No such file or directory', 404);
	}
	if (!isInside(realRoot, abs)) throw new FileAccessError('Path is outside the project', 403);
	const rel = relative(realRoot, abs).split(sep).join('/');
	if (isGitPath(rel)) throw new FileAccessError('Path is outside the project', 403);
	return { abs, rel, realRoot };
}

/**
 * The entries of `paths` (relative to `root`) that git ignores, asked through
 * stdin, never a shell; an error counts as none ignored.
 */
async function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
	const out = await new Promise<string>((done) => {
		const child = execFile(
			'git',
			['check-ignore', '-z', '--stdin'],
			{ cwd: root, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
			// Exit 1 means nothing given is ignored.
			(_err, stdout) => done(stdout ?? '')
		);
		child.stdin?.on('error', () => {});
		child.stdin?.end(paths.join('\0') + '\0');
	});
	return new Set(out.split('\0').filter(Boolean));
}

/** Directories first, then by name as a person would sort them. */
function byTypeThenName(a: FileEntry, b: FileEntry): number {
	if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * One directory of the project. A symlink is listed as what it points to,
 * and left out when it points outside the root or nowhere.
 */
export async function listDir(
	root: string,
	dir: string,
	opts: { repo: boolean; showIgnored?: boolean }
): Promise<DirListing> {
	const { abs, rel, realRoot } = await resolveInRoot(root, dir || '.');
	const dirents = await readdir(abs, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
		throw new FileAccessError(err.code === 'ENOTDIR' ? 'Not a directory' : 'Cannot read directory', 400);
	});
	const entries: FileEntry[] = [];
	await Promise.all(
		dirents.map(async (d) => {
			const path = rel ? `${rel}/${d.name}` : d.name;
			if (isGitPath(path)) return;
			if (d.isDirectory()) return void entries.push({ name: d.name, path, type: 'dir' });
			if (d.isFile()) return void entries.push({ name: d.name, path, type: 'file' });
			if (!d.isSymbolicLink()) return;
			try {
				const target = await realpath(join(abs, d.name));
				if (!isInside(realRoot, target)) return;
				const s = await stat(target);
				entries.push({ name: d.name, path, type: s.isDirectory() ? 'dir' : 'file', link: true });
			} catch {
				// a dangling link
			}
		})
	);
	let hidden = 0;
	let shown = entries;
	if (opts.repo && entries.length > 0) {
		// git wants a directory spelled with its slash to match a `dir/` pattern, and answers in the same
		// spelling; a link to one goes without, since git refuses a path that runs through a symlink.
		const spelled = (e: FileEntry) => (e.type === 'dir' && !e.link ? `${e.path}/` : e.path);
		const ignored = await ignoredPaths(realRoot, entries.map(spelled));
		for (const e of entries) if (ignored.has(spelled(e))) e.ignored = true;
		if (!opts.showIgnored) {
			shown = entries.filter((e) => !e.ignored);
			hidden = entries.length - shown.length;
		}
	}
	return { root: realRoot, dir: rel, repo: opts.repo, entries: shown.sort(byTypeThenName), hidden };
}

/** The first `limit` bytes of a file. */
async function readHead(abs: string, limit: number): Promise<Buffer> {
	const handle = await open(abs, 'r');
	try {
		const buf = Buffer.allocUnsafe(limit);
		const { bytesRead } = await handle.read(buf, 0, limit, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Read one file: text up to READ_LIMIT_BYTES (cut at a line end where one is
 * near), an image's type for the raw route, or `binary` for anything with a
 * NUL in its first bytes.
 */
export async function readProjectFile(root: string, path: string): Promise<FileRead> {
	const { abs, rel } = await resolveInRoot(root, path);
	const s = await stat(abs);
	if (!s.isFile()) throw new FileAccessError('Not a file', 400);
	const mime = imageMimeFor(abs);
	if (mime) return { kind: 'image', path: rel, size: s.size, mime };
	const head = await readHead(abs, Math.min(s.size, READ_LIMIT_BYTES));
	if (head.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'binary', path: rel, size: s.size };
	const truncated = s.size > READ_LIMIT_BYTES;
	let bytes = head;
	if (truncated) {
		// Cut at the last line end so the final line is whole.
		const nl = bytes.lastIndexOf(0x0a);
		if (nl > 0) bytes = bytes.subarray(0, nl + 1);
	}
	// The decoder holds back a character split by the cut rather than mangling it.
	const text = new StringDecoder('utf8').write(bytes);
	return { kind: 'text', path: rel, size: s.size, shown: Buffer.byteLength(text), text, truncated };
}

/** An image's bytes, through the same guard as any read. */
export async function readProjectImage(root: string, path: string): Promise<{ bytes: Buffer; mime: string }> {
	const { abs } = await resolveInRoot(root, path);
	const mime = imageMimeFor(abs);
	if (!mime) throw new FileAccessError('Not an image', 415);
	const s = await stat(abs);
	if (!s.isFile()) throw new FileAccessError('Not a file', 400);
	if (s.size > IMAGE_LIMIT_BYTES) throw new FileAccessError('Image too large', 413);
	return { bytes: await readFile(abs), mime };
}

/**
 * Every file git tracks plus the untracked ones it does not ignore, for
 * quick-open. Null outside a repo or when git fails.
 */
export async function listRepoFiles(root: string): Promise<{ files: string[]; truncated: boolean } | null> {
	const out = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
	if (out === null) return null;
	const files = [...new Set(out.split('\0').filter(Boolean))];
	return { files: files.slice(0, LIST_LIMIT), truncated: files.length > LIST_LIMIT };
}
