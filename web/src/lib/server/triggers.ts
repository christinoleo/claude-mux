import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import { pageOriginAllowed } from '$shared/server/page-origin.js';
import { getAllSessions, isSessionDead } from '$shared/db/sessions-json.js';
import { CLAUDE_MUX_DIR } from '$shared/utils/paths.js';
import { capturePaneContentAsync, isPaneReadyForCommand, readTypedText } from '$shared/tmux/pane.js';
import { Scheduler, fileTriggerStore, type RunSession } from '$shared/server/triggers.js';
import { realTmux } from '$shared/server/worker-queue.js';
import { shellQuote } from '$shared/utils/shell.js';
import { machineOn } from '$shared/server/machine-switch.js';
import { workerQueue } from '$lib/server/worker-queue.js';

/**
 * This server's scheduler (`src/server/triggers.ts`), started beside the
 * event poller and the worker queue, whose limit and memory brake a session
 * Run goes through.
 */

const g = globalThis as typeof globalThis & { __claudeMuxScheduler?: Scheduler };

function runSessions(): RunSession[] {
	return getAllSessions()
		.filter((s) => !!s.run_id && !isSessionDead(s))
		.map((s) => ({
			id: s.id,
			runId: s.run_id!,
			target: s.tmux_target,
			state: s.state,
			turnCompletedAt: s.turn_completed_at ?? null,
			backgroundTasks: s.background_tasks ?? 0
		}));
}

/**
 * A command for every session Run in place of `claude`, with `{prompt}` for
 * its prompt, shell-quoted: for a test under a HOME of its own, never set on
 * a real installation.
 */
function runCommandOverride(): ((prompt: string) => string) | undefined {
	const template = process.env.CLAUDE_MUX_RUN_COMMAND;
	return template ? (prompt) => template.replaceAll('{prompt}', shellQuote(prompt)) : undefined;
}

/** The scheduler, started with the poller; null on a server that does not run it. */
export function scheduler(): Scheduler | null {
	return g.__claudeMuxScheduler ?? null;
}

/**
 * The scheduler for a request that changes Triggers, or the refusal to send:
 * a Trigger can start sessions on this machine, so only its own page or a
 * peer's relay may ask, and only a server that runs the scheduler.
 */
export function schedulerFor(request: Request): Scheduler | Response {
	if (!pageOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
		return json({ error: 'cross-origin request refused' }, { status: 403 });
	}
	return scheduler() ?? json({ error: 'This server runs no scheduler, so nothing would fire' }, { status: 409 });
}

export function startScheduler(): Scheduler {
	if (g.__claudeMuxScheduler) return g.__claudeMuxScheduler;
	const s = new Scheduler({
		store: fileTriggerStore(join(CLAUDE_MUX_DIR, 'triggers.json')),
		tmux: realTmux,
		exitDir: join(CLAUDE_MUX_DIR, 'runs'),
		on: machineOn,
		// null is the queue's "yes", so it cannot stand for a missing queue too.
		room: (starting) => {
			const queue = workerQueue();
			return queue ? queue.room(starting) : 'This server runs no worker queue';
		},
		sessions: runSessions,
		capture: (window) => capturePaneContentAsync(window, true),
		atPrompt: isPaneReadyForCommand,
		typed: readTypedText,
		runCommand: runCommandOverride()
	});
	g.__claudeMuxScheduler = s;
	s.start();
	return s;
}
