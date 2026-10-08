/**
 * What git says changed in the repo a session works in — the "Current"
 * source of the Changes panel, which catches edits made through Bash that
 * the session's log never records.
 *
 * Every call goes through `execFile` with an argument list, never a shell,
 * and every path a caller names is checked against the repo root before git
 * sees it. Status is cached per repo and re-read only when a session in the
 * repo writes its JSON (each hook event does), and then at most once every
 * REFRESH_MS: there is no timer polling git.
 */

import { execFile } from 'child_process';
import { closeSync, openSync, readSync, statSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { PatchHunk } from '../transcript/parser.js';
import { summarize, type ChangesSummary } from '../transcript/changes.js';
import { getSession } from '../db/sessions-json.js';
import { sessionWatcher } from './watcher.js';

export type GitFileKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitFileStatus {
	/** Relative to the repo root, `/`-separated as git prints it. */
	file: string;
	/** Where a renamed or copied file came from. */
	oldPath?: string;
	kind: GitFileKind;
	untracked?: true;
	binary?: true;
	additions: number;
	deletions: number;
}

export interface GitChanges {
	root: string;
	files: GitFileStatus[];
	/** What the counts are taken against: HEAD, or the empty tree before the first commit. */
	base: string;
}

export interface GitDiff {
	file: string;
	binary: boolean;
	hunks: PatchHunk[];
}

/** A file's line counts, as numstat gives them or as counted off an untracked file. */
interface LineCount {
	additions: number;
	deletions: number;
	binary: boolean;
}

/** The fastest a repo is re-read, however often its sessions change. */
const REFRESH_MS = 2_000;
/** A repo nobody has asked about for this long is dropped. */
const FORGET_MS = 10 * 60_000;
/** A directory found not to be in a work tree is asked again only this often. */
const NO_REPO_RETRY_MS = 60_000;
/** Untracked files bigger than this are listed without counting their lines. */
const COUNT_LIMIT_BYTES = 2 * 1024 * 1024;
/** What git writes for an empty tree, to diff against in a repo with no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(
	args: string[],
	cwd: string,
	okCodes: number[] = [0]
): Promise<string | null> {
	return new Promise((done) => {
		execFile(
			'git',
			['-c', 'core.quotepath=off', ...args],
			{ cwd, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => {
				const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
				done(okCodes.includes(code) ? stdout : null);
			}
		);
	});
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain=v2 -z`. Ordinary entries (`1`) carry one path,
 * renames and copies (`2`) a second NUL-terminated field with the old path,
 * unmerged entries (`u`) count as modified, and untracked ones (`?`) as added.
 * Ignored entries (`!`) and headers (`#`) are dropped.
 */
export function parsePorcelainV2(out: string): Omit<GitFileStatus, 'additions' | 'deletions'>[] {
	const fields = out.split('\0');
	const files: Omit<GitFileStatus, 'additions' | 'deletions'>[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		const type = field[0];
		if (type === '?') {
			files.push({ file: field.slice(2), kind: 'added', untracked: true });
		} else if (type === '1') {
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			const parts = field.split(' ');
			files.push({ file: parts.slice(8).join(' '), kind: kindOf(parts[1]) });
		} else if (type === '2') {
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
			const parts = field.split(' ');
			const oldPath = fields[++i] ?? '';
			const file = parts.slice(9).join(' ');
			files.push({ file, oldPath, kind: parts[8].startsWith('C') ? 'added' : 'renamed' });
		} else if (type === 'u') {
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			files.push({ file: field.split(' ').slice(10).join(' '), kind: 'modified' });
		}
	}
	return files;
}

/** The kind an ordinary entry's XY reads as; the worktree column wins over the index. */
function kindOf(xy: string): GitFileKind {
	if (xy.includes('D')) return 'deleted';
	if (xy[0] === 'A') return 'added';
	return 'modified';
}

/**
 * Parse `git diff --numstat -z`: `add\tdel\tpath\0`, or for a rename
 * `add\tdel\t\0old\0new\0`. A binary file counts as `-\t-`.
 */
export function parseNumstat(out: string): Map<string, LineCount> {
	const counts = new Map<string, LineCount>();
	const fields = out.split('\0');
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		const [add, del, path] = field.split('\t');
		if (del === undefined) continue;
		// A rename leaves the path empty and spells old and new in the next fields.
		const file = path ? path : (i += 2, fields[i] ?? '');
		const binary = add === '-' && del === '-';
		counts.set(file, {
			additions: binary ? 0 : Number(add) || 0,
			deletions: binary ? 0 : Number(del) || 0,
			binary
		});
	}
	return counts;
}

/** Split a unified diff into hunks, dropping the file headers above the first. */
export function parseUnifiedDiff(out: string): { binary: boolean; hunks: PatchHunk[] } {
	const hunks: PatchHunk[] = [];
	let binary = false;
	let current: PatchHunk | null = null;
	for (const line of out.split('\n')) {
		if (line.startsWith('diff ')) {
			// A second file section (a rename git no longer pairs): its headers are not hunk lines.
			current = null;
		} else if (line.startsWith('@@')) {
			current = { header: line.replace(/^(@@[^@]*@@).*$/, '$1'), lines: [] };
			hunks.push(current);
		} else if (current && /^[ +\-\\]/.test(line)) {
			current.lines.push(line);
		} else if (!current && /^Binary files .* differ$|^GIT binary patch$/.test(line)) {
			binary = true;
		}
	}
	return { binary, hunks };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The repo-relative form of `file` when it names something inside `root`,
 * or null when it climbs out or is absolute elsewhere.
 */
export function confinePath(root: string, file: string): string | null {
	if (!file || file.includes('\0')) return null;
	const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
	const rel = relative(root, abs);
	if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
	return rel.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Reading a repo
// ---------------------------------------------------------------------------

/** Untracked counts by path, kept while the file's size and mtime hold. */
const untrackedCounts = new Map<string, { size: number; mtimeMs: number; count: LineCount | null }>();

/** Lines in a file git does not know yet, or binary when it holds a NUL. */
function countUntracked(path: string): LineCount | null {
	try {
		const { size, mtimeMs } = statSync(path);
		const memo = untrackedCounts.get(path);
		if (memo && memo.size === size && memo.mtimeMs === mtimeMs) return memo.count;
		const count = readLineCount(path, size);
		untrackedCounts.set(path, { size, mtimeMs, count });
		return count;
	} catch {
		untrackedCounts.delete(path);
		return null;
	}
}

function readLineCount(path: string, size: number): LineCount | null {
	try {
		if (size > COUNT_LIMIT_BYTES) return null;
		const buffer = Buffer.alloc(size);
		const fd = openSync(path, 'r');
		try {
			readSync(fd, buffer, 0, size, 0);
		} finally {
			closeSync(fd);
		}
		if (buffer.subarray(0, 8000).includes(0)) return { additions: 0, deletions: 0, binary: true };
		let lines = 0;
		for (let i = buffer.indexOf(0x0a); i !== -1; i = buffer.indexOf(0x0a, i + 1)) lines++;
		if (size > 0 && buffer[size - 1] !== 0x0a) lines++;
		return { additions: lines, deletions: 0, binary: false };
	} catch {
		return null;
	}
}

/** HEAD, or the empty tree when the repo has no commits yet. */
async function baseRev(root: string): Promise<string> {
	return (await git(['rev-parse', '--verify', '-q', 'HEAD'], root)) ? 'HEAD' : EMPTY_TREE;
}

async function readChanges(root: string): Promise<GitChanges | null> {
	const [status, base] = await Promise.all([
		git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], root),
		baseRev(root)
	]);
	if (status === null) return null;
	const numstat = (await git(['diff', '--numstat', '-z', '-M', base], root)) ?? '';
	const counts = parseNumstat(numstat);
	const entries = parsePorcelainV2(status);
	// Drop memoised counts for files under this root that are no longer untracked.
	const untracked = new Set(entries.filter((e) => e.untracked).map((e) => resolve(root, e.file)));
	for (const path of untrackedCounts.keys()) {
		if (path.startsWith(root + sep) && !untracked.has(path)) untrackedCounts.delete(path);
	}
	const files = entries.map((entry): GitFileStatus => {
		const count = entry.untracked
			? countUntracked(resolve(root, entry.file))
			: counts.get(entry.file);
		return {
			...entry,
			additions: count?.additions ?? 0,
			deletions: count?.deletions ?? 0,
			...(count?.binary ? { binary: true as const } : {})
		};
	});
	return { root, files, base };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface RepoState {
	changes: GitChanges | null;
	refreshedAt: number;
	dirty: boolean;
	inflight: Promise<GitChanges | null> | null;
	trailing: ReturnType<typeof setTimeout> | null;
	askedAt: number;
}

/** cwd → repo root, or null when the cwd is in no work tree (with when that was found). */
const roots = new Map<string, { root: string | null; at: number }>();
/** Lookups in flight, so a tick that comes round first does not ask twice. */
const resolving = new Map<string, Promise<string | null>>();
const repos = new Map<string, RepoState>();
let unsubscribe: (() => void) | null = null;

/** Forget everything — for tests. */
export function resetGitCache(): void {
	for (const repo of repos.values()) if (repo.trailing) clearTimeout(repo.trailing);
	roots.clear();
	resolving.clear();
	untrackedCounts.clear();
	repos.clear();
	unsubscribe?.();
	unsubscribe = null;
}

/** The work tree `cwd` sits in, or null outside one. */
export async function repoRoot(cwd: string): Promise<string | null> {
	const known = roots.get(cwd);
	if (known && (known.root !== null || Date.now() - known.at < NO_REPO_RETRY_MS)) return known.root;
	let pending = resolving.get(cwd);
	if (!pending) {
		pending = git(['rev-parse', '--show-toplevel'], cwd).then((out) => {
			const root = out ? out.trim() || null : null;
			roots.set(cwd, { root, at: Date.now() });
			resolving.delete(cwd);
			return root;
		});
		resolving.set(cwd, pending);
	}
	return pending;
}

/**
 * A session's JSON changed, which a hook does on every event it handles:
 * the repo it works in may have changed on disk too.
 */
function noteSessionChanged(cwd: string): void {
	// git prints the root with symlinks resolved, so a cwd reached through one matches only by lookup.
	const known = roots.get(cwd)?.root;
	for (const [root, repo] of repos) {
		if (root === known || cwd === root || cwd.startsWith(root + '/')) {
			repo.dirty = true;
			schedule(root, repo);
		}
	}
}

function watch(): void {
	if (unsubscribe) return;
	unsubscribe = sessionWatcher.subscribe((changed) => {
		for (const id of changed) {
			const cwd = getSession(id)?.cwd;
			if (cwd) noteSessionChanged(cwd);
		}
	});
}

function refresh(root: string, repo: RepoState): Promise<GitChanges | null> {
	if (repo.inflight) return repo.inflight;
	repo.dirty = false;
	repo.refreshedAt = Date.now();
	repo.inflight = readChanges(root)
		.then((changes) => {
			repo.changes = changes;
			return changes;
		})
		.finally(() => {
			repo.inflight = null;
			// A hook landed while git was reading: what it changed may be missing.
			if (repo.dirty) schedule(root, repo);
		});
	return repo.inflight;
}

/** Re-read a dirty repo now, or as soon as the throttle allows. */
function schedule(root: string, repo: RepoState): void {
	if (Date.now() - repo.askedAt > FORGET_MS) {
		if (repo.trailing) clearTimeout(repo.trailing);
		repos.delete(root);
		return;
	}
	if (repo.inflight || repo.trailing) return;
	const wait = repo.refreshedAt + REFRESH_MS - Date.now();
	if (wait <= 0) {
		void refresh(root, repo);
		return;
	}
	repo.trailing = setTimeout(() => {
		repo.trailing = null;
		if (repo.dirty) void refresh(root, repo);
	}, wait);
}

function stateFor(root: string): RepoState {
	let repo = repos.get(root);
	if (!repo) {
		repo = { changes: null, refreshedAt: 0, dirty: true, inflight: null, trailing: null, askedAt: Date.now() };
		repos.set(root, repo);
	}
	repo.askedAt = Date.now();
	watch();
	return repo;
}

/**
 * The repo's changes, read fresh when a hook has touched it since the last
 * read (or it was never read) and the throttle allows; otherwise cached.
 * Null outside a work tree.
 */
export async function gitChanges(cwd: string): Promise<GitChanges | null> {
	const root = await repoRoot(cwd);
	if (!root) return null;
	const repo = stateFor(root);
	if (repo.inflight) return repo.inflight;
	if (repo.changes && (!repo.dirty || Date.now() - repo.refreshedAt < REFRESH_MS)) {
		if (repo.dirty) schedule(root, repo);
		return repo.changes;
	}
	return refresh(root, repo);
}

/**
 * What the broadcast shows for a cwd, without waiting on git: the last read
 * when there is one, null when the cwd is in no repo, undefined while that is
 * still being found out. Kicks off the read it needs.
 */
export function peekGitSummary(cwd: string): ChangesSummary | null | undefined {
	// The root last resolved, without asking git; undefined when not asked yet.
	const root = roots.get(cwd)?.root;
	if (root === undefined) {
		void gitChanges(cwd);
		return undefined;
	}
	if (root === null) {
		// Asks git again once the retry window has passed, so a later `git init` is noticed.
		void repoRoot(cwd);
		return null;
	}
	const repo = stateFor(root);
	if (!repo.changes) {
		schedule(root, repo);
		return repo.refreshedAt ? null : undefined;
	}
	return summarize(repo.changes.files);
}

/**
 * One file's diff against HEAD, working tree included. `file` is checked
 * against the repo root and must be one the status lists; null otherwise.
 */
export async function gitFileDiff(cwd: string, file: string): Promise<GitDiff | null> {
	const changes = await gitChanges(cwd);
	if (!changes) return null;
	const rel = confinePath(changes.root, file);
	if (!rel) return null;
	const entry = changes.files.find((f) => f.file === rel);
	if (!entry) return null;
	const out = entry.untracked
		? // --no-index exits 1 when the files differ, which they always do here.
			await git(['diff', '--no-index', '--', '/dev/null', rel], changes.root, [0, 1])
		: await git(
				['diff', '-M', changes.base, '--', ...(entry.oldPath ? [entry.oldPath] : []), rel],
				changes.root
			);
	if (out === null) return null;
	const parsed = parseUnifiedDiff(out);
	return { file: rel, binary: parsed.binary || entry.binary === true, hunks: parsed.hunks };
}

/** The branch checked out at `root`, or null on a detached HEAD or outside a repo. */
export async function currentBranch(root: string): Promise<string | null> {
	const out = await git(['symbolic-ref', '--short', '-q', 'HEAD'], root);
	return out?.trim() || null;
}
