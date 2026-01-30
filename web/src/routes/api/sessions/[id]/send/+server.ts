import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFileSync, execSync } from 'child_process';

export const POST: RequestHandler = async ({ params, request }) => {
	const target = decodeURIComponent(params.id);
	const body = await request.json();
	const keys = body.keys || 'Escape';
	const text = body.text; // For literal text input

	try {
		if (text) {
			// For large text, use tmux buffer to avoid command-line length limits
			// Load text into a named buffer via stdin, then paste it
			execSync(`tmux load-buffer -b claude-mux-input -`, {
				input: text,
				stdio: ['pipe', 'ignore', 'ignore']
			});
			execFileSync('tmux', ['paste-buffer', '-b', 'claude-mux-input', '-t', target], {
				stdio: 'ignore'
			});
			execFileSync('tmux', ['delete-buffer', '-b', 'claude-mux-input'], { stdio: 'ignore' });
			execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
		} else {
			execFileSync('tmux', ['send-keys', '-t', target, keys], { stdio: 'ignore' });
		}
		return json({ ok: true });
	} catch {
		return json({ error: 'Failed to send keys' }, { status: 500 });
	}
};
