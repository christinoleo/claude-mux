/**
 * Resume a past session on the machine that holds it (`POST <base>/api/past/<id>/resume`).
 * The machine starts `claude --resume` in the folder the session ran in, or
 * answers that the session is live already (its pane is the answer), or that
 * the folder is gone, with the project's root to offer instead.
 */

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
