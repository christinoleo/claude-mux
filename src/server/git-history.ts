/**
 * A repo's commits, for the side panel's History pane.
 *
 * Read on request and never cached: a few hundred commits with their line
 * counts take git a few hundred milliseconds, and the pane asks again only
 * when its session's commits may have changed. Everything goes through `execFile` with the revision validated first, so
 * nothing a browser sends is ever parsed by a shell or taken for an option.
 */

import {
	confinePath,
	git,
	parseNumstat,
	parseUnifiedDiff,
	repoRoot,
	type GitDiff,
	type GitFileKind
} from './git.js';

export interface HistoryCommit {
	hash: string;
	parents: string[];
	author: string;
	/** Committer time, ms. */
	at: number;
	subject: string;
	/** Branches and tags that point here, as git names them: `main`, `origin/main`, `tag: v1`. */
	refs: string[];
	additions: number;
	deletions: number;
	files: number;
	/** False while no remote branch holds the commit yet; always true in a repo with no remote. */
	pushed: boolean;
}

/** A branch checked out somewhere: the repo itself, or one of its worktrees. */
export interface HistoryTip {
	path: string;
	branch: string | null;
	hash: string;
}

export interface GitHistory {
	root: string;
	/** The branch checked out where the session sits, or null on a detached HEAD. */
	branch: string | null;
	commits: HistoryCommit[];
	/** Every checkout of the repo, so a lane can be named after the worker in it. */
	tips: HistoryTip[];
	/** More commits exist than were listed. */
	truncated: boolean;
}

export interface CommitFile {
	file: string;
	oldPath?: string;
	kind: GitFileKind;
	binary?: true;
	additions: number;
	deletions: number;
}

/** `branch` follows the checked-out branch alone; `all` adds every worktree's branch and the upstream. */
export type HistoryScope = 'branch' | 'all';

/** Commits listed at once: enough to scroll back a few weeks, and a graph a browser draws without thought. */
export const HISTORY_LIMIT = 300;
/** What git writes for an empty tree, to diff a root commit against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const RECORD = '\x1e';
const FIELD = '\x1f';
const FORMAT = `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ct${FIELD}%D${FIELD}%s`;
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/** Parse `git log` written with `FORMAT` and `--shortstat`. */
export function parseLog(out: string): Omit<HistoryCommit, 'pushed'>[] {
	const commits: Omit<HistoryCommit, 'pushed'>[] = [];
	for (const record of out.split(RECORD)) {
		if (!record.trim()) continue;
		const [head, ...rest] = record.split('\n');
		const [hash, parents, author, ct, refs, subject] = head.split(FIELD);
		if (!hash || subject === undefined) continue;
		const stat = SHORTSTAT.exec(rest.join('\n'));
		commits.push({
			hash,
			parents: parents ? parents.split(' ') : [],
			author,
			at: Number(ct) * 1000,
			subject,
			refs: refs
				? refs
						.split(', ')
						.map((r) => r.replace(/^HEAD -> /, ''))
						.filter((r) => r !== 'HEAD' && !r.endsWith('/HEAD'))
				: [],
			files: Number(stat?.[1] ?? 0),
			additions: Number(stat?.[2] ?? 0),
			deletions: Number(stat?.[3] ?? 0)
		});
	}
	return commits;
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktrees(out: string): HistoryTip[] {
	const tips: HistoryTip[] = [];
	for (const block of out.split('\n\n')) {
		const path = /^worktree (.+)$/m.exec(block)?.[1];
		const hash = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1];
		if (!path || !hash) continue;
		const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
		tips.push({ path, branch, hash });
	}
	return tips;
}

/** Parse `git diff --name-status -z`: `M\0path\0`, or `R100\0old\0new\0` for a rename or copy. */
export function parseNameStatus(out: string): Pick<CommitFile, 'file' | 'oldPath' | 'kind'>[] {
	const files: Pick<CommitFile, 'file' | 'oldPath' | 'kind'>[] = [];
	const fields = out.split('\0');
	for (let i = 0; i < fields.length; i++) {
		const code = fields[i];
		if (!code) continue;
		if (code[0] === 'R' || code[0] === 'C') {
			files.push({ file: fields[i + 2] ?? '', oldPath: fields[i + 1], kind: 'renamed' });
			i += 2;
		} else {
			files.push({ file: fields[i + 1] ?? '', kind: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified' });
			i += 1;
		}
	}
	return files.filter((f) => f.file);
}

export async function gitHistory(cwd: string, scope: HistoryScope): Promise<GitHistory | null> {
	const root = await repoRoot(cwd);
	if (!root) return null;
	const [worktrees, branchOut, upstream, remotes] = await Promise.all([
		git(['worktree', 'list', '--porcelain'], root),
		git(['symbolic-ref', '--short', '-q', 'HEAD'], root, [0, 1]),
		git(['rev-parse', '--verify', '-q', '@{upstream}'], root, [0, 1, 128]),
		git(['remote'], root)
	]);
	const tips = parseWorktrees(worktrees ?? '');
	const revs = new Set(['HEAD']);
	if (scope === 'all') {
		for (const tip of tips) revs.add(tip.hash);
		if (upstream?.trim()) revs.add(upstream.trim());
	}
	const from = [...revs];
	const [log, local] = await Promise.all([
		// One more than is shown says whether there is more.
		git(['log', '--date-order', `-n${HISTORY_LIMIT + 1}`, FORMAT, '--shortstat', ...from, '--'], root),
		remotes?.trim()
			? git(['rev-list', `-n${HISTORY_LIMIT + 1}`, ...from, '--not', '--remotes', '--'], root)
			: Promise.resolve('')
	]);
	if (log === null) return null;
	const unpushed = new Set((local ?? '').split('\n').filter(Boolean));
	const parsed = parseLog(log);
	return {
		root,
		branch: branchOut?.trim() || null,
		commits: parsed.slice(0, HISTORY_LIMIT).map((c) => ({ ...c, pushed: !unpushed.has(c.hash) })),
		tips,
		truncated: parsed.length > HISTORY_LIMIT
	};
}

/** A full or abbreviated hash and nothing else: never a ref name, a range or an option. */
const HASH = /^[0-9a-f]{7,40}$/;

/** The commit a hash names and what to diff it against: its first parent, or the empty tree. */
async function resolveCommit(root: string, hash: string): Promise<{ hash: string; base: string } | null> {
	if (!HASH.test(hash)) return null;
	const full = (await git(['rev-parse', '--verify', '-q', `${hash}^{commit}`], root, [0, 1, 128]))?.trim();
	if (!full || !HASH.test(full)) return null;
	// A root commit has no parent to name; rev-parse says so with a non-zero exit.
	const parent = (await git(['rev-parse', '--verify', '-q', `${full}^`], root, [0, 1, 128]))?.trim();
	return { hash: full, base: parent && HASH.test(parent) ? parent : EMPTY_TREE };
}

/** The files a commit changed against its first parent, which for a merge is what the merge brought in. */
export async function commitFiles(cwd: string, hash: string): Promise<{ hash: string; files: CommitFile[] } | null> {
	const root = await repoRoot(cwd);
	const commit = root && (await resolveCommit(root, hash));
	if (!root || !commit) return null;
	const [names, counts] = await Promise.all([
		git(['diff', '-M', '--name-status', '-z', commit.base, commit.hash, '--'], root),
		git(['diff', '-M', '--numstat', '-z', commit.base, commit.hash, '--'], root)
	]);
	if (names === null || counts === null) return null;
	const lines = parseNumstat(counts);
	const files = parseNameStatus(names).map((f) => {
		const count = lines.get(f.file);
		return {
			...f,
			additions: count?.additions ?? 0,
			deletions: count?.deletions ?? 0,
			...(count?.binary ? { binary: true as const } : {})
		};
	});
	return { hash: commit.hash, files };
}

/** One file's diff within a commit; null when the commit or the path is not one this repo has. */
export async function commitFileDiff(cwd: string, hash: string, file: string): Promise<GitDiff | null> {
	const root = await repoRoot(cwd);
	const commit = root && (await resolveCommit(root, hash));
	const rel = root && confinePath(root, file);
	if (!root || !commit || !rel) return null;
	const out = await git(['diff', '-M', commit.base, commit.hash, '--', rel], root);
	if (out === null) return null;
	const parsed = parseUnifiedDiff(out);
	return { file: rel, binary: parsed.binary, hunks: parsed.hunks };
}

/** The most of a file read for a diff's hidden lines; past it the rest stays hidden. */
const TEXT_LIMIT_BYTES = 1024 * 1024;

/**
 * A file as a commit left it, for showing the lines a diff leaves out. Null
 * when the commit has no such file (it was deleted there) or it is not text.
 */
export async function commitFileText(
	cwd: string,
	hash: string,
	file: string
): Promise<{ text: string; truncated: boolean } | null> {
	const root = await repoRoot(cwd);
	const commit = root && (await resolveCommit(root, hash));
	const rel = root && confinePath(root, file);
	if (!root || !commit || !rel) return null;
	const out = await git(['show', `${commit.hash}:${rel}`], root, [0]);
	if (out === null || out.includes('\0')) return null;
	const truncated = out.length > TEXT_LIMIT_BYTES;
	return { text: truncated ? out.slice(0, TEXT_LIMIT_BYTES) : out, truncated };
}
