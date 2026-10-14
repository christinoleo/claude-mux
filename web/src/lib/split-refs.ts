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
import { machineBase, sessionPath } from './session-route';

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

/**
 * Where to go for a single session: always a page of this host, which
 * reaches another host's session through its relay (`/m/<host>/session/…`).
 * A host not known yet keeps its name; its page says when the machine
 * does not answer.
 */
export function singleUrl(ref: PaneRef, servers: ServerInfo[], self: string): string {
	return sessionPath(machineBase(ref.host, servers, self) === '' ? { host: null, target: ref.target } : ref);
}

/**
 * The URL a pane's iframe loads: the session's page on this same origin, in
 * embed mode, whichever machine the session is on.
 */
export function paneUrl(ref: PaneRef, servers: ServerInfo[], self: string): string {
	return `${singleUrl(ref, servers, self)}?embed=1`;
}

/** The URL of a split with `a` in the first pane and `b` in the second. */
export function splitUrl(a: PaneRef, b: PaneRef): string {
	return `/session/${encodeURIComponent(formatRef(a))}?with=${encodeURIComponent(formatRef(b))}`;
}
