import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { homedir } from 'os';
import { existsSync, statSync, readdirSync } from 'fs';
import { access, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname, join } from 'path';
import { folderNameProblem } from '$shared/folder-name.js';

const execFileAsync = promisify(execFile);

/** A .git child marks a folder as a repo — the signal that matters when picking a project. */
async function isRepo(dir: string): Promise<boolean> {
	return access(join(dir, '.git')).then(
		() => true,
		() => false
	);
}

export const GET: RequestHandler = async ({ url }) => {
	let targetPath = url.searchParams.get('path') || homedir();
	const showHidden = url.searchParams.get('showHidden') === 'true';

	// Normalize and resolve path
	if (targetPath.startsWith('~')) {
		targetPath = targetPath.replace('~', homedir());
	}
	targetPath = resolve(targetPath);

	try {
		if (!existsSync(targetPath)) {
			return json({ error: 'Directory not found' }, { status: 404 });
		}

		const stat = statSync(targetPath);
		if (!stat.isDirectory()) {
			return json({ error: 'Not a directory' }, { status: 400 });
		}

		const entries = readdirSync(targetPath, { withFileTypes: true });
		const dirs = entries
			.filter((e) => {
				if (!e.isDirectory()) return false;
				if (!showHidden && e.name.startsWith('.')) return false;
				return true;
			})
			.map((e) => ({ name: e.name, path: join(targetPath, e.name) }))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

		const repos = await Promise.all(dirs.map((d) => isRepo(d.path)));
		const folders = dirs.map((d, i) => ({ ...d, git: repos[i] }));

		const parent = dirname(targetPath);

		return json({
			current: targetPath,
			home: homedir(),
			parent: targetPath === '/' || targetPath === parent ? null : parent,
			folders
		});
	} catch (err: unknown) {
		const error = err as { code?: string };
		if (error.code === 'ENOENT') {
			return json({ error: 'Directory not found' }, { status: 404 });
		}
		if (error.code === 'EACCES') {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		return json({ error: 'Failed to read directory' }, { status: 500 });
	}
};

/**
 * Make a folder in the one browsed: `{ parent, name, git }`, answering the new
 * folder's path. `git` runs `git init` in it; a folder made whose init fails is
 * kept, and the answer says so.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const parent = typeof body?.parent === 'string' ? body.parent : '';
	const name = typeof body?.name === 'string' ? body.name : '';
	const problem = folderNameProblem(name);
	if (problem) return json({ error: problem }, { status: 400 });
	if (!parent.startsWith('/')) return json({ error: 'No folder to make it in' }, { status: 400 });

	const path = join(resolve(parent), name);
	try {
		await mkdir(path);
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === 'EEXIST') return json({ error: `${name} already exists` }, { status: 409 });
		if (code === 'ENOENT') return json({ error: 'Directory not found' }, { status: 404 });
		if (code === 'EACCES' || code === 'EPERM') return json({ error: 'Permission denied' }, { status: 403 });
		return json({ error: 'Could not make the folder' }, { status: 500 });
	}
	if (body?.git === true) {
		try {
			await execFileAsync('git', ['init', '-q'], { cwd: path, timeout: 10_000 });
		} catch {
			return json({ path, warning: 'Folder made, but git init failed' });
		}
	}
	return json({ path });
};
