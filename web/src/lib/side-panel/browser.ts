/**
 * The Web pane's Browser source, apart from the component: turning what
 * happens on the canvas into the messages the stream takes (see
 * `toCdpInput()` in `src/server/browser-view.ts`), and picking the tab to show.
 */
import type { BrowserInfo, BrowserTab } from '$shared/server/browser-view.js';

export type { BrowserInfo, BrowserWsMessage } from '$shared/server/browser-view.js';

/** The `?url=` value that names the remote browser rather than a site. */
export const BROWSER_CHOICE = 'browser';

/** The size, in CSS pixels, of the remote viewport a frame shows. */
export interface FrameSize {
	width: number;
	height: number;
}

/** The box the frame is drawn in, as `getBoundingClientRect()` has it. */
export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * A point on this screen as a point in the remote page, in its CSS pixels.
 * The canvas is the frame scaled to fit, so the mapping is one ratio; a point
 * dragged past the edge is held to it.
 */
export function toPagePoint(clientX: number, clientY: number, box: Box, frame: FrameSize): { x: number; y: number } {
	const along = (at: number, start: number, size: number, remote: number) =>
		size > 0 ? Math.round(Math.min(Math.max((at - start) / size, 0), 1) * remote) : 0;
	return {
		x: along(clientX, box.left, box.width, frame.width),
		y: along(clientY, box.top, box.height, frame.height)
	};
}

/** How the canvas is magnified on this side: a scale about its centre, then a shift in screen pixels. */
export interface View {
	scale: number;
	x: number;
	y: number;
}

export const UNZOOMED: View = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 8;

/**
 * `view` after a zoom by `factor` that carries what was under `from` to `to`
 * (both screen points): a pinch whose midpoint moved, or a wheel zoom about
 * the pointer when the two are the same. `box` is where the canvas lies
 * unzoomed, and `room` the size of the space it may fill, which it is centred
 * in. The canvas never shrinks below its fit, and once it is larger than the
 * room on an axis it never leaves a gap at that axis's edges.
 */
export function zoomView(
	view: View,
	from: { x: number; y: number },
	to: { x: number; y: number },
	factor: number,
	box: Box,
	room: { width: number; height: number } = box
): View {
	const scale = Math.min(Math.max(view.scale * factor, 1), MAX_ZOOM);
	const cx = box.left + box.width / 2;
	const cy = box.top + box.height / 2;
	const shift = (at: number, dest: number, centre: number, offset: number, size: number, space: number) => {
		const limit = Math.max(0, (scale * size - space) / 2);
		// The point of the canvas under `at`, measured from its centre before any zoom.
		const on = (at - centre - offset) / view.scale;
		return Math.min(Math.max(dest - centre - scale * on, -limit), limit);
	};
	return {
		scale,
		x: shift(from.x, to.x, cx, view.x, box.width, room.width),
		y: shift(from.y, to.y, cy, view.y, box.height, room.height)
	};
}

interface Modified {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/** CDP's modifier bit field: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: Modified): number {
	return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const MOUSE_BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const;

/** The name CDP gives `MouseEvent.button`. */
export function buttonName(button: number): string {
	return MOUSE_BUTTONS[button] ?? 'none';
}

/** The button a move is dragging with, from `MouseEvent.buttons`. */
export function heldButton(buttons: number): string {
	return buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
}

interface KeyLike extends Modified {
	key: string;
	code: string;
	keyCode: number;
}

interface KeyMessage {
	type: 'key';
	event: 'down' | 'up';
	key: string;
	code: string;
	keyCode: number;
	text?: string;
	modifiers: number;
}

/**
 * The message for a key going down or up, or null for one the remote page
 * should not get: the side panel's own Alt+Shift shortcuts, and paste, whose
 * text arrives by the paste event from this machine's clipboard instead of
 * the remote one's.
 */
export function keyMessage(e: KeyLike, event: 'down' | 'up'): KeyMessage | null {
	if (e.altKey && e.shiftKey) return null;
	const command = e.ctrlKey || e.metaKey;
	if (command && e.key.toLowerCase() === 'v') return null;
	const msg: KeyMessage = { type: 'key', event, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiersOf(e) };
	// A key that types carries its text; without it the page sees the key and no character.
	if (event === 'down' && !command) {
		if (e.key === 'Enter') msg.text = '\r';
		else if ([...e.key].length === 1) msg.text = e.key;
	}
	return msg;
}

/**
 * What to do remotely so that text which read `prev` reads `next`: how many
 * characters to delete off the end, then what to type. The phone keyboard's
 * field is mirrored this way, because autocorrect and composition rewrite
 * what is already there rather than only appending.
 */
export function textDelta(prev: string, next: string): { backspaces: number; insert: string } {
	const a = [...prev];
	const b = [...next];
	let same = 0;
	while (same < a.length && same < b.length && a[same] === b[same]) same++;
	return { backspaces: a.length - same, insert: b.slice(same).join('') };
}

/**
 * The tab to show: the one the URL names while it is open, else the one
 * already showing (`staying`), else the one the session last opened or
 * selected, else the browser's first. The session's tab is found by its URL,
 * which stops matching as soon as the page goes anywhere, so without
 * `staying` a click on a link would hand the view, and the person's next
 * keystrokes, to some other tab.
 */
export function pickTab(
	info: Pick<BrowserInfo, 'tabs' | 'preferred'> | null,
	wanted: string | undefined,
	staying: string | null = null
): BrowserTab | null {
	if (!info) return null;
	const byId = (id: string | null | undefined) => (id ? info.tabs.find((t) => t.id === id) : undefined);
	return byId(wanted) ?? byId(staying) ?? byId(info.preferred) ?? info.tabs[0] ?? null;
}

/** The tabs whose title or URL contains every word of `query`. */
export function filterTabs(tabs: BrowserTab[], query: string): BrowserTab[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return tabs;
	return tabs.filter((t) => {
		const hay = `${t.title} ${t.url}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** Whether the remote browser on `base`'s machine answers, so a page can be opened in it. */
export async function browserAnswers(base: string): Promise<boolean> {
	try {
		const res = await fetch(`${base}/api/browser/tabs`);
		if (!res.ok) return false;
		const info = (await res.json()) as BrowserInfo;
		return !!info.name && !info.error;
	} catch {
		return false;
	}
}

/**
 * Show a GitHub page in the remote browser, in a background tab of its own
 * (the same one again for a page opened before), and answer that tab's id.
 */
export async function openInBrowser(base: string, url: string): Promise<{ tab: string } | { error: string }> {
	try {
		const res = await fetch(`${base}/api/browser/open`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url })
		});
		const body = (await res.json().catch(() => null)) as { tab?: unknown; error?: unknown } | null;
		if (res.ok && typeof body?.tab === 'string') return { tab: body.tab };
		return { error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}` };
	} catch (err) {
		return { error: `Could not reach claude-mux: ${err}` };
	}
}
