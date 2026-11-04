/**
 * Read-only access to the files of the project a session works in, for the
 * side panel's Files pane: one directory at a time, one file at a time, and
 * the repo's file list for quick-open.
 *
 * The root is the session's repo (`git_root`, else the work tree its cwd sits
 * in), or the cwd itself outside a repo. By default a path is resolved with
 * `realpath` and refused unless it lands inside the root's own realpath, so
 * neither `..` nor a symlink that points out of the project reaches anything
 * else. A caller that asks with `anywhere` may reach any path the server can
 * read, relative or absolute, through links or not (the Files pane does:
 * whoever reaches this API can already type into a shell, and a project often
 * links to a folder on another mount). `.git` is never listed or read, whatever
 * the path that leads to it.
 */

import { execFile } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { realpath, readdir, readFile, stat, open } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'path';
import type { Session } from '../db/sessions-json.js';
import { git, repoRoot } from './git.js';
import { imageMimeFor } from '../utils/image-types.js';

/** Text past this many bytes is cut off, and the answer says so. */
export const READ_LIMIT_BYTES = 1024 * 1024;
/** Images past this size are refused. */
const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
/** PDFs past this size are refused: the whole file goes through the server's memory. */
const PDF_LIMIT_BYTES = 200 * 1024 * 1024;
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
	/** A symlink. `type` is what it points to, and `path` runs through the link. */
	link?: true;
	/** A symlink that leads nowhere the server can follow: its target is gone, or it is a loop. */
	broken?: true;
}

export interface DirListing {
	root: string;
	/** The directory listed, as asked for: relative to the root ('' for the root itself), or absolute. */
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
	| { kind: 'image' | 'pdf'; path: string; size: number; mime: string }
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

/** Whether `abs` is `root` or sits somewhere below it. */
export function isInside(root: string, abs: string): boolean {
	const rel = relative(root, abs);
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** A `.git` directory at any depth (a submodule's, a vendored repo's) or anything in one. */
function isGitPath(rel: string): boolean {
	return rel.split('/').includes('.git');
}

/** Where the read routes may reach: the root only, or any path as well. */
export interface Reach {
	anywhere?: boolean;
}

/** A path in `/`-separated form, whatever the platform spells it with. */
const slashed = (path: string) => path.split(sep).join('/');

/** A real path as `.git` is judged on it: from the root when it sits inside, else absolute. */
const fromRealRoot = (realRoot: string, abs: string) =>
	slashed(isInside(realRoot, abs) ? relative(realRoot, abs) : abs);

/**
 * Resolve `path` (relative to `root`, or absolute) to a real path. An absolute
 * path is taken as given, so one that names the root through another spelling
 * (a symlink to it) still resolves. Throws a 403 for a path in `.git`, however
 * it gets there, and a 404 for one that is not there. Without `anywhere` a path
 * that lands outside the root is a 403 as well.
 *
 * `spelled` is the path the way it was asked for, from the root where it sits
 * below it: `link/sub` stays that, whichever disk the link leads to, so it can
 * be walked back to the project. `rel` is the path to settle on: from the root
 * for a file really inside it (`link/sub` becomes `src/sub` when the link
 * points to `src`), else `spelled`. A path that is below the root in neither
 * sense is its absolute real path in both.
 */
export async function resolveInRoot(
	root: string,
	path: string,
	reach: Reach = {}
): Promise<{ abs: string; rel: string; spelled: string; realRoot: string }> {
	if (path.includes('\0')) throw new FileAccessError('Invalid path', 400);
	const realRoot = await realpath(root).catch(() => {
		throw new FileAccessError('Project directory not found', 404);
	});
	const wanted = isAbsolute(path) ? resolve(path) : resolve(realRoot, path);
	const base = isInside(realRoot, wanted)
		? realRoot
		: isAbsolute(path) && isInside(resolve(root), wanted)
			? resolve(root)
			: null;
	// Refuse a path that climbs out before touching the disk, so its existence is not told.
	if (base === null && !reach.anywhere) throw new FileAccessError('Path is outside the project', 403);
	let abs: string;
	try {
		abs = await realpath(wanted);
	} catch {
		throw new FileAccessError('No such file or directory', 404);
	}
	const inside = isInside(realRoot, abs);
	if (!inside && !reach.anywhere) throw new FileAccessError('Path is outside the project', 403);
	const real = fromRealRoot(realRoot, abs);
	const spelled = base === null ? real : slashed(relative(base, wanted));
	if (isGitPath(real) || isGitPath(spelled)) throw new FileAccessError('Path is inside .git', 403);
	return { abs, rel: inside ? real : spelled, spelled, realRoot };
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
 * One directory of the project. A symlink is listed as what it points to, with
 * a path that runs through it, so opening one link never lists a tree that
 * holds itself. Without `anywhere` a link that points outside the root is left
 * out; with it, one that leads nowhere is listed as `broken`.
 */
export async function listDir(
	root: string,
	dir: string,
	opts: { repo: boolean; showIgnored?: boolean } & Reach
): Promise<DirListing> {
	const { abs, rel, spelled, realRoot } = await resolveInRoot(root, dir || '.', opts);
	const dirents = await readdir(abs, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
		throw new FileAccessError(err.code === 'ENOTDIR' ? 'Not a directory' : 'Cannot read directory', 400);
	});
	const below = (from: string, name: string) => (from ? `${from.replace(/\/$/, '')}/${name}` : name);
	const entries: FileEntry[] = [];
	await Promise.all(
		dirents.map(async (d) => {
			const path = below(spelled, d.name);
			if (isGitPath(path)) return;
			if (d.isDirectory()) return void entries.push({ name: d.name, path, type: 'dir' });
			if (d.isFile()) return void entries.push({ name: d.name, path, type: 'file' });
			if (!d.isSymbolicLink()) return;
			try {
				const target = await realpath(join(abs, d.name));
				if (!isInside(realRoot, target) && !opts.anywhere) return;
				if (isGitPath(fromRealRoot(realRoot, target))) return;
				const s = await stat(target);
				entries.push({ name: d.name, path, type: s.isDirectory() ? 'dir' : 'file', link: true });
			} catch {
				if (opts.anywhere) entries.push({ name: d.name, path, type: 'file', link: true, broken: true });
			}
		})
	);
	let hidden = 0;
	let shown = entries;
	// A folder outside the project: git has no say there, however it was reached.
	if (opts.repo && isInside(realRoot, abs) && entries.length > 0) {
		// git knows the folder by its real path. It wants a directory spelled with its slash to match a
		// `dir/` pattern, and answers in the same spelling; a link to one goes without, since git refuses a
		// path that runs through a symlink.
		const spelledForGit = (e: FileEntry) => {
			const path = below(rel, e.name);
			return e.type === 'dir' && !e.link ? `${path}/` : path;
		};
		const ignored = await ignoredPaths(realRoot, entries.map(spelledForGit));
		for (const e of entries) if (ignored.has(spelledForGit(e))) e.ignored = true;
		if (!opts.showIgnored) {
			// A link stays, dimmed: the folder it leads to is seldom meant for git, and is why it is there.
			shown = entries.filter((e) => !e.ignored || (e.link && opts.anywhere));
			hidden = entries.length - shown.length;
		}
	}
	return { root: realRoot, dir: spelled, repo: opts.repo, entries: shown.sort(byTypeThenName), hidden };
}

/** A file the server may not read (common on a shared mount) is a refusal, not a crash. */
function refuseUnreadable(err: NodeJS.ErrnoException): never {
	if (err.code === 'EACCES' || err.code === 'EPERM') throw new FileAccessError('Permission denied', 403);
	throw err;
}

/** The first `limit` bytes of a file. */
async function readHead(abs: string, limit: number): Promise<Buffer> {
	const handle = await open(abs, 'r').catch(refuseUnreadable);
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
 * near), an image's or a PDF's type for the raw route, or `binary` for anything
 * else with a NUL in its first bytes.
 */
export async function readProjectFile(root: string, path: string, reach: Reach = {}): Promise<FileRead> {
	const { abs, rel } = await resolveInRoot(root, path, reach);
	const s = await stat(abs);
	if (!s.isFile()) throw new FileAccessError('Not a file', 400);
	const media = mediaFor(abs);
	if (media) return { kind: media.kind, path: rel, size: s.size, mime: media.mime };
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

/** Judged on the real path, so a link named `.pdf` cannot hand out whatever it points at. */
function mediaFor(abs: string): { kind: 'image' | 'pdf'; mime: string; limit: number } | null {
	const image = imageMimeFor(abs);
	if (image) return { kind: 'image', mime: image, limit: IMAGE_LIMIT_BYTES };
	return abs.toLowerCase().endsWith('.pdf') ? { kind: 'pdf', mime: 'application/pdf', limit: PDF_LIMIT_BYTES } : null;
}

/** An image's or a PDF's bytes, through the same guard as any read. */
export async function readProjectMedia(
	root: string,
	path: string,
	reach: Reach = {}
): Promise<{ bytes: Buffer<ArrayBuffer>; mime: string }> {
	const { abs } = await resolveInRoot(root, path, reach);
	const media = mediaFor(abs);
	if (!media) throw new FileAccessError('Not an image or a PDF', 415);
	const s = await stat(abs);
	if (!s.isFile()) throw new FileAccessError('Not a file', 400);
	if (s.size > media.limit) throw new FileAccessError('File too large', 413);
	return { bytes: await readFile(abs).catch(refuseUnreadable), mime: media.mime };
}

/**
 * Where a path written in a message points, as a path `resolveInRoot` takes.
 * Such a path is rarely spelled from the root: it is tried as given, then
 * against the session's `cwd` (and `~` as the home directory), and last as
 * the tail of a repo file's path, taken only when exactly one file ends with
 * it (`TranscriptView.svelte`, `lib/markdown.ts`). One that is nowhere comes
 * back as given, for the read to refuse in its own words. The root goes
 * first so that a path which is exact, as the panes' own are, stays exact. One
 * that climbs (`../x`) means the cwd and nothing else: with `anywhere` it stays
 * spelled from there even when it is nowhere, or the read would look for it
 * from the root and could open another file.
 */
export async function locateProjectFile(root: string, path: string, cwd: string, reach: Reach = {}): Promise<string> {
	const found = async (candidate: string): Promise<boolean> => {
		try {
			await resolveInRoot(root, candidate, reach);
			return true;
		} catch (err) {
			if (err instanceof FileAccessError) return false;
			throw err;
		}
	};
	if (path.startsWith('~/')) return join(homedir(), path.slice(2));
	const climbs = normalize(path).split(sep)[0] === '..';
	if (isAbsolute(path) || (!climbs && (await found(path)))) return path;
	const fromCwd = join(cwd, path);
	if (await found(fromCwd)) return fromCwd;
	if (climbs) return reach.anywhere ? fromCwd : path;
	const tail = path.replace(/^(?:\.\/)+/, '');
	const listed = await listRepoFiles(root);
	// A list that was cut cannot say a match is the only one.
	if (!listed || listed.truncated) return path;
	const matches = listed.files.filter((f) => f.endsWith(`/${tail}`));
	return matches.length === 1 ? matches[0] : path;
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
