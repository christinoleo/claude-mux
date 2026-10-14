/**
 * Resume a past session on the machine that holds it (`POST <base>/api/past/<id>/resume`).
 * The machine starts `claude --resume` in the folder the session ran in, or
 * answers that the session is live already (its pane is the answer), or that
 * the folder is gone, with the project's root to offer instead.
 */

import { isSettled, setSettled, type Machine } from '$lib/stores/fleet.svelte';

export type ResumeResult =
	/** Running now in `tmuxTarget`: started, or `live` already. */
	| { kind: 'ok'; tmuxTarget: string; live: boolean }
	| { kind: 'folder-gone'; cwd: string | null; root: string | null }
	| { kind: 'error'; message: string };

export async function requestResume(base: string, id: string, cwd?: string): Promise<ResumeResult> {
	let res: Response;
	try {
		res = await fetch(`${base}/api/past/${encodeURIComponent(id)}/resume`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(cwd ? { cwd } : {})
		});
	} catch {
		return { kind: 'error', message: 'The machine did not answer.' };
	}
	const data = await res.json().catch(() => ({}));
	if (res.ok && typeof data.tmuxTarget === 'string') return { kind: 'ok', tmuxTarget: data.tmuxTarget, live: !!data.live };
	if (res.status === 409) return { kind: 'folder-gone', cwd: data.cwd ?? null, root: data.root ?? null };
	return { kind: 'error', message: [data.error, data.detail].filter(Boolean).join(': ') || `Resume failed (${res.status}).` };
}

export type ResumeOutcome =
	| { kind: 'ok'; tmuxTarget: string }
	/** The folder it ran in is gone: the project's root, to offer in its place. */
	| { kind: 'offer-root'; cwd: string | null; root: string }
	| { kind: 'error'; message: string };

/**
 * Resume a past session and settle what follows: a gone folder becomes the
 * root to offer (only when none was chosen yet), and a resumed session that
 * was settled before it ended goes back among the live ones.
 */
export async function resumePast(machine: Machine | null, base: string, id: string, cwd?: string): Promise<ResumeOutcome> {
	const result = await requestResume(base, id, cwd);
	if (result.kind === 'folder-gone') {
		if (result.root && !cwd) return { kind: 'offer-root', cwd: result.cwd, root: result.root };
		return { kind: 'error', message: `${result.cwd ?? 'The folder it ran in'} is gone, and no project folder holds it.` };
	}
	if (result.kind === 'error') return result;
	if (machine && isSettled(machine, id)) setSettled(machine, id, false);
	return { kind: 'ok', tmuxTarget: result.tmuxTarget };
}
