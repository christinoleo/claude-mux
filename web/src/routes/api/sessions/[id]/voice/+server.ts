import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sendTextToPane } from '$shared/server/message-queue.js';
import { transcribeAudio } from '$lib/server/voice/index.js';
import { discoverCommands, type DiscoveredCommand } from '$shared/claude/commands.js';
import { hasSpokenCommandTrigger, resolveSpokenCommand } from '$shared/claude/voice-command.js';
import { resolveSession } from '$shared/commands/resolve-session.js';
import { recordDictation } from '$shared/server/dictation-marks.js';

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

	const session = resolveSession(target);

	// "Barra model" / "slash model" spoken at the start of an utterance becomes
	// the real slash command, matched against what this session's cwd can see.
	// The trigger pre-check keeps the command-discovery directory scan off the
	// path of ordinary dictated prose.
	let command: DiscoveredCommand | null = null;
	if (text && hasSpokenCommandTrigger(text)) {
		try {
			const resolved = resolveSpokenCommand(text, discoverCommands(session?.cwd));
			text = resolved.text;
			command = resolved.command;
		} catch (err) {
			console.error('[voice] spoken-command resolution failed:', err);
		}
	}

	if (inject && text) {
		try {
			sendTextToPane(target, text, { appendEnter: submit });
			// Remember what went in by voice, so the transcript can badge it. A
			// resolved slash command renders as its own kind of turn instead, so
			// only prose is recorded.
			if (session && !command) recordDictation(session.id, text);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'send-keys failed';
			return json({ text, injected: false, error: message }, { status: 200 });
		}
	}

	return json({
		text,
		injected: inject && Boolean(text),
		submitted: inject && submit && Boolean(text)
	});
};
