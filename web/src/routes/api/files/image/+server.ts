import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync, statSync } from 'fs';
import { imageMimeFor } from '$shared/utils/image-types.js';

export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path');

	if (!path) {
		return json({ error: 'path parameter required' }, { status: 400 });
	}

	// Basic security: don't allow path traversal
	if (path.includes('..')) {
		return json({ error: 'Invalid path' }, { status: 400 });
	}

	try {
		if (!existsSync(path)) {
			return json({ error: 'File not found' }, { status: 404 });
		}

		const stat = statSync(path);
		if (!stat.isFile()) {
			return json({ error: 'Not a file' }, { status: 400 });
		}

		// Limit file size to 50MB
		if (stat.size > 50 * 1024 * 1024) {
			return json({ error: 'File too large' }, { status: 413 });
		}

		const mimeType = imageMimeFor(path);

		if (!mimeType) {
			return json({ error: 'Unsupported image format' }, { status: 400 });
		}

		const content = readFileSync(path);

		return new Response(content, {
			headers: {
				'Content-Type': mimeType,
				'Content-Length': String(content.length),
				'Cache-Control': 'public, max-age=300'
			}
		});
	} catch (err: unknown) {
		const e = err as { code?: string };
		if (e.code === 'EACCES') {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		return json({ error: 'Failed to read file' }, { status: 500 });
	}
};
