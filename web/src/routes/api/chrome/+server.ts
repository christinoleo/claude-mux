import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execSync } from 'child_process';

export const DELETE: RequestHandler = async () => {
	try {
		// Find and kill Chrome/Brave processes with remote debugging enabled
		let killed = 0;
		try {
			// Find Chrome/Chromium/Brave processes with --remote-debugging (pipe or port)
			const psOutput = execSync(
				"ps aux | grep -E '(chrome|chromium|brave)' | grep -E 'remote-debugging-(pipe|port)' | grep -v grep | awk '{print $2}'",
				{ encoding: 'utf-8' }
			).trim();

			if (psOutput) {
				const pids = psOutput.split('\n').filter(Boolean);
				for (const pid of pids) {
					try {
						execSync(`kill ${pid}`, { stdio: 'ignore' });
						killed++;
					} catch {
						// Process may have already exited
					}
				}
			}
		} catch {
			// No matching processes found
		}

		return json({ ok: true, killed });
	} catch {
		return json({ error: 'Failed to close Chrome' }, { status: 500 });
	}
};
