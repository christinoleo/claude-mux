/**
 * The browser's side of the story, written into the server's log.
 *
 * An intermittent failure on a phone leaves nothing behind: no console, no
 * stack, no way to ask what the page thought it was showing. Errors, page
 * navigations and the session page's own "the URL says one session and I am
 * drawing another" check are sent here, so `journalctl` has them.
 */

import { browser } from '$app/environment';

export type ClientLogKind = 'error' | 'nav' | 'stale' | 'viewport';

export function reportClient(kind: ClientLogKind, data: Record<string, unknown>): void {
	if (!browser) return;
	const body = JSON.stringify({
		kind,
		data,
		url: location.pathname + location.search,
		ua: navigator.userAgent.slice(0, 120),
		at: new Date().toISOString()
	});
	try {
		if (!navigator.sendBeacon?.('/api/client-log', new Blob([body], { type: 'application/json' }))) {
			void fetch('/api/client-log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: true
			});
		}
	} catch {
		/* the log is not worth breaking anything over */
	}
}

/** Window-level error capture; call once from the root layout. */
export function watchClientErrors(): () => void {
	if (!browser) return () => {};
	const onError = (e: ErrorEvent) =>
		reportClient('error', {
			message: e.message,
			stack: e.error instanceof Error ? e.error.stack?.slice(0, 1500) : null,
			source: `${e.filename}:${e.lineno}:${e.colno}`
		});
	const onRejection = (e: PromiseRejectionEvent) =>
		reportClient('error', {
			message: e.reason instanceof Error ? e.reason.message : String(e.reason).slice(0, 300),
			stack: e.reason instanceof Error ? e.reason.stack?.slice(0, 1500) : null,
			source: 'unhandledrejection'
		});
	window.addEventListener('error', onError);
	window.addEventListener('unhandledrejection', onRejection);
	return () => {
		window.removeEventListener('error', onError);
		window.removeEventListener('unhandledrejection', onRejection);
	};
}

/** How far the page may sit off its place before it counts as displaced. */
const DISPLACED_PX = 8;
/** Long enough for the keyboard to finish leaving before anything is measured. */
const SETTLE_MS = 350;

function typing(): boolean {
	const el = document.activeElement;
	return (
		el instanceof HTMLInputElement ||
		el instanceof HTMLTextAreaElement ||
		(el instanceof HTMLElement && el.isContentEditable)
	);
}

/**
 * Puts the page back where it belongs once the keyboard has gone.
 *
 * The shell is exactly one screen tall and never scrolls, but iOS scrolls the
 * window anyway to bring a focused field above the keyboard, and does not
 * always scroll it back: the composer then floats a hand's width above the
 * bottom of the screen with the body's bare background under it. Nothing is
 * meant to be scrolled here, so when no field has focus the window goes back
 * to the top. What was measured goes to the server's log first, since this
 * only happens on a phone and "sometimes".
 */
export function watchViewport(): () => void {
	if (!browser) return () => {};
	const vv = window.visualViewport;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const settle = () => {
		if (typing()) return;
		const scrollY = Math.round(window.scrollY);
		const offsetTop = Math.round(vv?.offsetTop ?? 0);
		const layout = document.documentElement.clientHeight;
		const visual = Math.round(vv?.height ?? window.innerHeight);
		const displaced = scrollY > DISPLACED_PX || offsetTop > DISPLACED_PX;
		// A shell shorter than the screen it is drawn on is the other way to get
		// the same band, and scrolling cannot fix that one — only report it.
		const short = visual - layout > DISPLACED_PX;
		if (!displaced && !short) return;
		reportClient('viewport', {
			scrollY,
			offsetTop,
			layout,
			visual,
			inner: window.innerHeight,
			screen: window.screen.height,
			standalone: window.matchMedia('(display-mode: standalone)').matches
		});
		if (displaced) window.scrollTo(0, 0);
	};
	const check = () => {
		clearTimeout(timer);
		timer = setTimeout(settle, SETTLE_MS);
	};

	vv?.addEventListener('resize', check);
	vv?.addEventListener('scroll', check);
	window.addEventListener('focusout', check);
	window.addEventListener('pageshow', check);
	document.addEventListener('visibilitychange', check);
	return () => {
		clearTimeout(timer);
		vv?.removeEventListener('resize', check);
		vv?.removeEventListener('scroll', check);
		window.removeEventListener('focusout', check);
		window.removeEventListener('pageshow', check);
		document.removeEventListener('visibilitychange', check);
	};
}
