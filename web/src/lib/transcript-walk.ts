import type { TranscriptEntry } from '$shared/transcript/parser.js';

/**
 * Walking back through what a person wrote: each press of the session page's
 * button lands on the next message up. The page owns the scrolling; this owns
 * which message comes next, so it can be tested without a layout.
 */

/**
 * Whether an entry is a message a person wrote, with a row of its own on the
 * page. A prompt typed mid-turn is `queued` once the agent has seen it, so it
 * counts; one still waiting lives in the pane's queue and is no entry at all.
 * `delivered` marks a queued line a real user line repeats, whose row is hidden.
 * A local command that answered is left out: its row is mostly the harness.
 */
export function isWritten(entry: TranscriptEntry): boolean {
	if (entry.rewound) return false;
	if (entry.kind === 'queued') return !entry.delivered;
	return entry.kind === 'user' && !entry.localOutput && !entry.command?.output;
}

/** The ids of the messages a person wrote, oldest first. */
export function writtenIds(entries: TranscriptEntry[]): string[] {
	return entries.filter(isWritten).map((entry) => entry.id);
}

export interface WalkPosition {
	/** The transcript is pinned to its latest output. */
	atBottom: boolean;
	/**
	 * The message the last press landed on, while the reader has not scrolled
	 * since. A short final turn cannot reach the top of the view, so its place
	 * on screen does not say it was already visited.
	 */
	held: string | null;
	/** The top edge of the view, in the coordinates of `topOf`. */
	viewTop: number;
	/** Where a message starts on screen, or null when it has no row. */
	topOf: (id: string) => number | null;
}

const isAbove = (id: string, position: WalkPosition) => {
	const top = position.topOf(id);
	return top !== null && top < position.viewTop - 1;
};

/** The next message up from `position`, among those on the page. */
export function nextWritten(written: string[], position: WalkPosition): string | null {
	const at = position.held === null ? -1 : written.indexOf(position.held);
	if (at !== -1) return written[at - 1] ?? null;
	if (position.atBottom) return written[written.length - 1] ?? null;
	return written.findLast((id) => isAbove(id, position)) ?? null;
}

/**
 * Whether `nextWritten` would find a message. This keeps the button's state
 * honest on every scroll event, so it measures one row: they stack in order,
 * so the oldest is above the view whenever any is.
 */
export function hasWrittenAbove(written: string[], position: WalkPosition): boolean {
	const oldest = written[0];
	if (oldest === undefined) return false;
	if (position.held !== null && written.includes(position.held)) return position.held !== oldest;
	return position.atBottom || isAbove(oldest, position);
}

export type OlderWritten =
	| { status: 'found'; id: string }
	/** The history ran out without another message. */
	| { status: 'none' }
	/** The history did not arrive, so an older message may yet exist. */
	| { status: 'failed' };

export interface OlderSource {
	written: () => string[];
	firstIndex: () => number;
	loadEarlier: () => Promise<unknown>;
}

/**
 * Nothing above the reader is on the page: ask for older slices until one
 * holds a message. History only grows at the front, so the message wanted is
 * the one right before the oldest held now, wherever the rows have moved to.
 */
export async function loadOlderWritten(source: OlderSource): Promise<OlderWritten> {
	const oldest = source.written()[0] ?? null;
	while (source.firstIndex() > 0) {
		const before = source.firstIndex();
		await source.loadEarlier();
		if (source.firstIndex() >= before) return { status: 'failed' };
		const written = source.written();
		const at = oldest === null ? written.length : written.indexOf(oldest);
		if (at === -1) return { status: 'failed' };
		if (at > 0) return { status: 'found', id: written[at - 1] };
	}
	return { status: 'none' };
}
