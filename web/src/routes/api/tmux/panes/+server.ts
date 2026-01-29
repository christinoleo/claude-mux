import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execSync } from 'child_process';

export interface TmuxPane {
	target: string;
	session: string;
	command: string;
}

export const GET: RequestHandler = async () => {
	try {
		const output = execSync(
			'tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}"',
			{ encoding: 'utf-8' }
		);

		const panes: TmuxPane[] = output
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [target, command] = line.split('\t');
				const session = target.split(':')[0];
				return { target, session, command };
			});

		return json(panes);
	} catch {
		return json([]);
	}
};
