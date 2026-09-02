/**
 * How a pane names the session it shows, across machines.
 *
 * A session on this host is its tmux target, `claude-mux-claude-1788…:1.1`.
 * One on another host is prefixed with that host's tailnet name and an `@`:
 * `distilo@quita-b1:0.0`. The form is what goes in the URL (`?with=`) and
 * what a sidebar row carries when dragged, so both sides of a split can be
 * anywhere on the tailnet.
 */

import type { ServerInfo } from '$lib/types/servers';

export interface PaneRef {
	/** Tailnet hostname, or null for the host that served this page. */
	host: string | null;
	/** tmux target, `session:window.pane`. */
	target: string;
}

export function parseRef(text: string): PaneRef | null {
	const value = text.trim();
	if (!value) return null;
	// A tmux target never contains `@`; a host never contains `:`.
	const at = value.indexOf('@');
	if (at === -1) return { host: null, target: value };
	const host = value.slice(0, at);
	const target = value.slice(at + 1);
	if (!host || !target || host.includes(':') || host.includes('/')) return null;
	return { host, target };
}

export function formatRef(ref: PaneRef): string {
	return ref.host ? `${ref.host}@${ref.target}` : ref.target;
}

export function sameRef(a: PaneRef | null, b: PaneRef | null): boolean {
	if (!a || !b) return a === b;
	return (a.host ?? null) === (b.host ?? null) && a.target === b.target;
}

/** The origin a pane's host answers on; null when the host is not known. */
export function hostOrigin(ref: PaneRef, servers: ServerInfo[], self: string): string | null {
	if (!ref.host || ref.host === self) return '';
	const server = servers.find((s) => s.hostname === ref.host);
	return server?.url.replace(/\/$/, '') ?? null;
}

/**
 * The URL a pane's iframe loads: that host's session page in embed mode,
 * with the pane's view preserved. Null when the host is unknown, which the
 * split shows as an unreachable pane rather than a broken frame.
 */
export function paneUrl(ref: PaneRef, servers: ServerInfo[], self: string): string | null {
	const origin = hostOrigin(ref, servers, self);
	if (origin === null) return null;
	return `${origin}/session/${encodeURIComponent(ref.target)}?embed=1`;
}

/**
 * Where to go for a single session: this host's page for a local one, the
 * remote host's page for one of theirs — which is a full navigation, since the
 * terminal and composer run against the session's own server.
 */
export function singleUrl(ref: PaneRef, servers: ServerInfo[], self: string): string | null {
	const origin = hostOrigin(ref, servers, self);
	if (origin === null) return null;
	return `${origin}/session/${encodeURIComponent(ref.target)}`;
}

/** The URL of a split with `a` in the first pane and `b` in the second. */
export function splitUrl(a: PaneRef, b: PaneRef): string {
	return `/session/${encodeURIComponent(formatRef(a))}?with=${encodeURIComponent(formatRef(b))}`;
}
