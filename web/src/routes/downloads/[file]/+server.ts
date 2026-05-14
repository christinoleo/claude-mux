import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES_DIR =
	process.env.CLAUDE_MUX_RELEASES_DIR ??
	fileURLToPath(new URL('../../../../../steamdeck/releases', import.meta.url));

export const GET: RequestHandler = async ({ params }) => {
	const name = basename(params.file);
	if (name !== params.file) throw error(400, 'bad name');

	const file = Bun.file(join(RELEASES_DIR, name));
	if (!(await file.exists())) throw error(404, 'not found');

	const isJson = name.endsWith('.json');
	const headers: Record<string, string> = {
		'Content-Type': isJson ? 'application/json' : 'application/octet-stream',
		'Content-Length': String(file.size)
	};
	if (!isJson) headers['Content-Disposition'] = `attachment; filename="${name}"`;

	return new Response(file.stream(), { status: 200, headers });
};
