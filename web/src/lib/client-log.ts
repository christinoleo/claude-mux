/**
 * The browser's side of the story, written into the server's log.
 *
 * An intermittent failure on a phone leaves nothing behind: no console, no
 * stack, no way to ask what the page thought it was showing. Errors, page
 * navigations and the session page's own "the URL says one session and I am
 * drawing another" check are sent here, so `journalctl` has them.
 */

import { browser } from '$app/environment';

export type ClientLogKind = 'error' | 'nav' | 'stale';

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
