import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execSync } from 'child_process';
import type { TmuxPane } from '$lib/types/tmux';

export type { TmuxPane };

export const GET: RequestHandler = async () => {
	try {
		const output = execSync(
			'tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_current_path}"',
			{ encoding: 'utf-8' }
		);

		const panes: TmuxPane[] = output
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [target, command, cwd] = line.split('\t');
				const session = target.split(':')[0];
				return { target, session, command, cwd: cwd || '' };
			});

		return json(panes);
	} catch {
		return json([]);
	}
};
