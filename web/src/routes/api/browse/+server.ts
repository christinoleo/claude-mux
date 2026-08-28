import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { homedir } from 'os';
import { existsSync, statSync, readdirSync } from 'fs';
import { access } from 'fs/promises';
import { resolve, dirname, join } from 'path';

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
