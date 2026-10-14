/**
 * Where a session lives in the page's URL, across machines.
 *
 * A session on the origin machine is `/session/<target>`, as it always was, so
 * old links keep working. One on another machine names that machine first:
 * `/m/<name>/session/<target>`, with the machine's short tailnet name, because
 * tmux targets repeat from one machine to the next. Both are pages of the
 * origin; only the calls the page makes go elsewhere (`machineBase()`).
 */

import type { PaneRef } from '$lib/split-refs';
import type { ServerInfo } from '$lib/types/servers';

export interface SessionRoute {
	ref: PaneRef;
	/** What follows the target, such as `/agent/<id>`; empty for the session itself. */
	rest: string;
}

/** The page of a session, `rest` (e.g. `/agent/<id>`) appended. */
export function sessionPath(ref: PaneRef, rest = ''): string {
	const machine = ref.host ? `/m/${encodeURIComponent(ref.host)}` : '';
	return `${machine}/session/${encodeURIComponent(ref.target)}${rest}`;
}

/** The session a pathname shows, or null when it is not a session's page. */
export function parseSessionPath(pathname: string): SessionRoute | null {
	const match = /^(?:\/m\/([^/]+))?\/session\/([^/]+)(\/.*)?$/.exec(pathname);
	if (!match) return null;
	try {
		const host = match[1] ? decodeURIComponent(match[1]) : null;
		const target = decodeURIComponent(match[2]);
		if (!target) return null;
		return { ref: { host, target }, rest: match[3] ?? '' };
	} catch {
		return null;
	}
}

/**
 * Where the API of the machine a route names is reached from this page: ''
 * for the origin itself (no name, or its own), `/fleet/<id>` through the
 * relay for any other, and null for a name discovery has not reported (yet).
 * The name is the short tailnet name; the relay wants the machine's id.
 */
export function machineBase(host: string | null, servers: ServerInfo[], self: string): string | null {
	if (!host) return '';
	const name = host.toLowerCase();
	if (name === self.toLowerCase()) return '';
	const server = servers.find((s) => s.hostname.toLowerCase() === name || s.id === host);
	if (!server?.id) return null;
	if (server.hostname === self) return '';
	return `/fleet/${encodeURIComponent(server.id)}`;
}

/**
 * `machineBase()`, with a name discovery has not reported tried as given:
 * the relay answers that one 404 ("unknown machine") rather than the page
 * having nowhere to send it.
 */
export function relayBase(host: string | null, servers: ServerInfo[], self: string): string {
	return machineBase(host, servers, self) ?? `/fleet/${encodeURIComponent(host ?? '')}`;
}

/** A route's ref with no host when it names this machine, so it compares equal to this machine's own refs. */
export function localRef(ref: PaneRef, servers: ServerInfo[], self: string): PaneRef {
	return machineBase(ref.host, servers, self) === '' ? { host: null, target: ref.target } : ref;
}
