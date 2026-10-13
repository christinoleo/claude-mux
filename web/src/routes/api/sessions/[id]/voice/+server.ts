import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { transcribeAudio } from '$lib/server/voice/index.js';
import { discoverCommands } from '$shared/claude/commands.js';
import { hasSpokenCommandTrigger, resolveSpokenCommand } from '$shared/claude/voice-command.js';
import { resolveSession } from '$shared/commands/resolve-session.js';

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Speech to text, and nothing else: the words go back to the browser, which
 * puts them in whichever field asked and delivers them the way it delivers
 * anything typed there. The session only says where to look for the slash
 * commands a spoken "barra model" may mean.
 */
export const POST: RequestHandler = async ({ params, request, url }) => {
	const target = decodeURIComponent(params.id);
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

	// "Barra model" / "slash model" spoken at the start of an utterance becomes
	// the real slash command, matched against what this session's cwd can see.
	// The trigger pre-check keeps the command-discovery directory scan off the
	// path of ordinary dictated prose.
	let command = false;
	if (text && hasSpokenCommandTrigger(text)) {
		try {
			const resolved = resolveSpokenCommand(text, discoverCommands(resolveSession(target)?.cwd));
			text = resolved.text;
			command = resolved.command !== null;
		} catch (err) {
			console.error('[voice] spoken-command resolution failed:', err);
		}
	}

	// The browser needs to know which it got: a slash command renders as its
	// own kind of turn, and is not marked as dictated when it is delivered.
	return json({ text, command });
};
