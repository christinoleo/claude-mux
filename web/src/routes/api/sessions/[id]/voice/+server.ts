import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sendTextToPane } from '$shared/server/message-queue.js';
import { transcribeAudio } from '$shared/server/voice/index.js';

const MAX_BYTES = 25 * 1024 * 1024;

export const POST: RequestHandler = async ({ params, request, url }) => {
	const target = decodeURIComponent(params.id);
	const inject = url.searchParams.get('inject') !== 'false';
	const submit = url.searchParams.get('submit') === '1';
	const language = url.searchParams.get('lang') ?? undefined;

	const contentType = request.headers.get('content-type') ?? 'audio/webm';
	const buf = await request.arrayBuffer();

	if (buf.byteLength === 0) {
		throw error(400, 'Empty audio body');
	}
	if (buf.byteLength > MAX_BYTES) {
		throw error(413, `Audio too large (max ${MAX_BYTES} bytes)`);
	}

	let text: string;
	try {
		text = await transcribeAudio(Buffer.from(buf), {
			mime: contentType,
			language,
			signal: request.signal
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Transcription failed';
		throw error(500, message);
	}

	if (inject && text) {
		try {
			sendTextToPane(target, text, { appendEnter: submit });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'send-keys failed';
			return json({ text, injected: false, error: message }, { status: 200 });
		}
	}

	return json({ text, injected: inject && Boolean(text), submitted: inject && submit && Boolean(text) });
};
