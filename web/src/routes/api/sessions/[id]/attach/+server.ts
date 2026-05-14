import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve, extname, basename } from 'path';
import { randomBytes } from 'crypto';
import { getSessionAttachmentsDir } from '$shared/db/index.js';

/** Strip path separators and control chars from a user-supplied filename. */
function sanitizeName(name: string): string {
	const base = basename(name).replace(/[\x00-\x1f\x7f/\\]/g, '_').trim();
	if (!base || base === '.' || base === '..') return 'file';
	return base.slice(0, 120);
}

/** Generate a short collision-resistant prefix. */
function shortId(): string {
	return randomBytes(4).toString('hex');
}

/** Verify a path lives under the given session's attachments dir. */
function isUnderSessionDir(sessionDir: string, candidate: string): boolean {
	const resolved = resolve(candidate);
	const root = resolve(sessionDir) + '/';
	return resolved.startsWith(root);
}

export const POST: RequestHandler = async ({ params, request }) => {
	const sessionId = decodeURIComponent(params.id);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'multipart/form-data required' }, { status: 400 });
	}

	const file = form.get('file');
	if (!(file instanceof File)) {
		return json({ error: 'file field required' }, { status: 400 });
	}

	const sessionDir = getSessionAttachmentsDir(sessionId);
	try {
		mkdirSync(sessionDir, { recursive: true });
	} catch (err: unknown) {
		return json({ error: 'Failed to create attachment dir' }, { status: 500 });
	}

	const original = sanitizeName(file.name || `paste${extname(file.type ? `.${file.type.split('/')[1] ?? 'bin'}` : '')}`);
	const stored = `${Date.now()}-${shortId()}-${original}`;
	const dest = join(sessionDir, stored);

	try {
		const buf = Buffer.from(await file.arrayBuffer());
		writeFileSync(dest, buf);
	} catch {
		return json({ error: 'Failed to write file' }, { status: 500 });
	}

	return json({
		path: dest,
		name: original,
		size: file.size,
		mime: file.type || 'application/octet-stream'
	});
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const sessionId = decodeURIComponent(params.id);
	const target = url.searchParams.get('path');
	if (!target) {
		return json({ error: 'path parameter required' }, { status: 400 });
	}

	const sessionDir = getSessionAttachmentsDir(sessionId);
	if (!isUnderSessionDir(sessionDir, target)) {
		return json({ error: 'path outside session attachments dir' }, { status: 400 });
	}

	try {
		if (existsSync(target)) {
			unlinkSync(target);
		}
	} catch {
		// Best-effort; report success either way to keep client state clean.
	}
	return json({ ok: true });
};
