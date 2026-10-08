/**
 * What the side panel's Web pane needs from this machine: the dev servers a
 * project is running, how tailscale serve exposes local ports over HTTPS, and
 * whether a page lets itself be framed.
 *
 * Discovery reads `ss -ltnpH` and each listener's `/proc/<pid>/cwd`, so it is
 * Linux-only; anywhere else it finds nothing rather than failing. Every
 * command goes through `execFile` with an argument list, never a shell.
 */

import { execFile } from 'child_process';
import { readlink } from 'fs/promises';
import { promisify } from 'util';
import { isLoopback } from '../utils/loopback.js';
import { isInside } from './files.js';

const execFileAsync = promisify(execFile);

/** How long a candidate dev server gets to answer the HTML probe. */
const PROBE_TIMEOUT_MS = 1_000;
/** How long a listener that did not answer with HTML is left alone. */
const NOT_HTML_RETRY_MS = 60_000;
/** How long the frame check waits for a page's headers. */
const FRAME_CHECK_TIMEOUT_MS = 4_000;
/** Tailscale's answers change rarely; the pane polls every few seconds. */
const TAILNET_CACHE_MS = 10_000;

/** One socket in LISTEN, as `ss` prints it. */
export interface Listener {
	/** The local address without the port: `127.0.0.1`, `::1`, `0.0.0.0`, `*`, `::`. */
	address: string;
	port: number;
	pid: number;
	process: string;
}

export interface DevServer {
	port: number;
	/** The URL to open it at from this machine. */
	url: string;
	pid: number;
	process: string;
	/** Bound to loopback alone, so nothing off this machine reaches it but a proxy. */
	loopbackOnly: boolean;
}

/** What `GET /api/sessions/<id>/web` answers. */
export interface WebInfo {
	root: string;
	/** The URLs `.claude-mux.json` names. */
	urls: Record<string, string>;
	configError: string | null;
	detected: DevServer[];
	/** Local port → the HTTPS URL tailscale serve proxies to it. */
	serves: Record<number, string>;
}

export type FrameCheck =
	| { embeddable: true }
	| { embeddable: false; reason: string }
	/** The check could not reach the page; the frame is tried anyway. */
	| { embeddable: null; reason: string };

const USERS_RE = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/;

/** The LISTEN sockets in `ss -ltnpH` output that name their process. */
export function parseListeners(out: string): Listener[] {
	const listeners: Listener[] = [];
	for (const line of out.split('\n')) {
		const cols = line.trim().split(/\s+/);
		if (cols[0] !== 'LISTEN' || cols.length < 6) continue;
		const users = USERS_RE.exec(line);
		if (!users) continue;
		const local = cols[3];
		const colon = local.lastIndexOf(':');
		const port = Number(local.slice(colon + 1));
		if (colon < 0 || !Number.isInteger(port)) continue;
		// `[::1]` and `127.0.0.1%lo` both lose their dressing.
		const address = local.slice(0, colon).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
		listeners.push({ address, port, pid: Number(users[2]), process: users[1] });
	}
	return listeners;
}

function isWildcard(address: string): boolean {
	return address === '*' || address === '0.0.0.0' || address === '::';
}

/** Where to reach a server bound to `addresses` from this machine. */
function localUrl(port: number, addresses: string[]): string {
	if (addresses.some((a) => isWildcard(a) || isLoopback(a))) return `http://localhost:${port}/`;
	return hostUrl(addresses[0], port);
}

function hostUrl(address: string, port: number): string {
	return `http://${address.includes(':') ? `[${address}]` : address}:${port}/`;
}

/**
 * Where this server can reach the listener, by the address it is bound to:
 * `localhost` may resolve to the one loopback (IPv4 or IPv6) it is not on.
 */
function probeUrl(port: number, addresses: string[]): string {
	if (addresses.some((a) => a === '*' || a === '0.0.0.0' || /^(::ffff:)?127\./.test(a))) {
		return hostUrl('127.0.0.1', port);
	}
	if (addresses.some((a) => a === '::' || a === '::1')) return hostUrl('::1', port);
	return hostUrl(addresses[0], port);
}

/** `url`'s response with redirects followed and the body left unread. */
async function fetchHeaders(url: string, timeoutMs: number): Promise<Response> {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
	void res.body?.cancel();
	return res;
}

/**
 * What the probe found per listener (`pid:port`): a listener that serves HTML
 * keeps doing so, so it is probed once; one that does not (a database, a JSON
 * API) is asked again only after NOT_HTML_RETRY_MS, rather than on every
 * poll. Entries go when their listener does.
 */
const probed = new Map<string, { html: boolean; at: number }>();

/** Whether `url` answers with an HTML page within the probe timeout. */
async function servesHtml(url: string): Promise<boolean> {
	try {
		const res = await fetchHeaders(url, PROBE_TIMEOUT_MS);
		return (res.headers.get('content-type') ?? '').includes('text/html');
	} catch {
		return false;
	}
}

/**
 * The listeners whose process works inside `root` and answers HTTP with HTML,
 * one per port, lowest port first. This server counts too: claude-mux's own
 * dev server is the dev server of the claude-mux repo.
 */
export async function detectDevServers(root: string): Promise<DevServer[]> {
	if (process.platform !== 'linux') return [];
	let out: string;
	try {
		({ stdout: out } = await execFileAsync('ss', ['-ltnpH'], { timeout: 2_000 }));
	} catch {
		return [];
	}
	const byPort = new Map<number, Listener[]>();
	const live = new Set<string>();
	for (const l of parseListeners(out)) {
		byPort.set(l.port, [...(byPort.get(l.port) ?? []), l]);
		live.add(`${l.pid}:${l.port}`);
	}
	for (const key of probed.keys()) if (!live.has(key)) probed.delete(key);
	const cwds = new Map<number, Promise<string | null>>();
	const cwdOf = (pid: number) => {
		if (!cwds.has(pid)) cwds.set(pid, readlink(`/proc/${pid}/cwd`).catch(() => null));
		return cwds.get(pid)!;
	};
	const found = await Promise.all(
		[...byPort].map(async ([port, socks]): Promise<DevServer | null> => {
			const cwd = await cwdOf(socks[0].pid);
			if (!cwd || !isInside(root, cwd)) return null;
			const addresses = socks.map((s) => s.address);
			const key = `${socks[0].pid}:${port}`;
			let seen = probed.get(key);
			if (!seen || (!seen.html && Date.now() - seen.at > NOT_HTML_RETRY_MS)) {
				seen = { html: await servesHtml(probeUrl(port, addresses)), at: Date.now() };
				probed.set(key, seen);
			}
			if (!seen.html) return null;
			const url = localUrl(port, addresses);
			return {
				port,
				url,
				pid: socks[0].pid,
				process: socks[0].process,
				loopbackOnly: addresses.every(isLoopback)
			};
		})
	);
	return found.filter((s): s is DevServer => s !== null).sort((a, b) => a.port - b.port);
}

interface ServeStatus {
	Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * Local port → HTTPS URL, from `tailscale serve status --json`. Only a handler
 * on `/` that proxies to loopback counts. Where one port is served under
 * several, the mapping that keeps the port number wins.
 */
export function parseServeStatus(status: ServeStatus): Record<number, string> {
	const serves: Record<number, string> = {};
	for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
		const proxy = web.Handlers?.['/']?.Proxy;
		if (!proxy) continue;
		let target: URL;
		try {
			target = new URL(proxy);
		} catch {
			continue;
		}
		if (target.protocol !== 'http:' || !isLoopback(target.hostname)) continue;
		const local = Number(target.port || 80);
		let served: URL;
		try {
			served = new URL(`https://${hostPort}`);
		} catch {
			continue;
		}
		if (!serves[local] || String(local) === (served.port || '443')) serves[local] = served.origin;
	}
	return serves;
}

let servesCache: { at: number; serves: Promise<Record<number, string>> } | null = null;

/** This machine's tailscale serve mappings, empty without tailscale. */
export function tailscaleServes(): Promise<Record<number, string>> {
	const now = Date.now();
	if (!servesCache || now - servesCache.at > TAILNET_CACHE_MS) {
		const serves = execFileAsync('tailscale', ['serve', 'status', '--json'], { timeout: 3_000 })
			.then(({ stdout }) => parseServeStatus(JSON.parse(stdout) as ServeStatus))
			.catch(() => ({}));
		servesCache = { at: now, serves };
	}
	return servesCache.serves;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Whether one CSP source expression lets `ours` frame a page served from `theirs`. */
function sourceAllows(source: string, ours: URL, theirs: URL): boolean {
	const s = source.toLowerCase();
	if (s === '*') return true;
	if (s === "'self'") return ours.origin === theirs.origin;
	// A source naming http also allows https.
	const schemeOk = (scheme: string) => ours.protocol === scheme || (scheme === 'http:' && ours.protocol === 'https:');
	if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return schemeOk(s);
	const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^:/]+)(?::(\*|\d+))?(?:\/.*)?$/.exec(s);
	if (!m) return false;
	const [, scheme, host, port] = m;
	if (scheme && !schemeOk(`${scheme}:`)) return false;
	const hostname = ours.hostname.toLowerCase();
	if (host !== '*' && !(host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : host === hostname)) return false;
	if (port === '*') return true;
	const ourPort = ours.port || DEFAULT_PORTS[ours.protocol];
	return (port ?? DEFAULT_PORTS[scheme ? `${scheme}:` : ours.protocol]) === ourPort;
}

/**
 * Whether a page answered with `headers` from `theirs` lets `ours` frame it.
 * A CSP `frame-ancestors` overrides `X-Frame-Options`, as browsers have it,
 * and every policy that names one must allow us.
 */
export function framingVerdict(headers: Headers, theirs: URL, ours: URL): FrameCheck {
	const policies = (headers.get('content-security-policy') ?? '').split(',');
	const ancestors = policies
		.map((p) => p.split(';').map((d) => d.trim().split(/\s+/)))
		.map((dirs) => dirs.find((d) => d[0]?.toLowerCase() === 'frame-ancestors'))
		.filter((d): d is string[] => d !== undefined);
	if (ancestors.length > 0) {
		for (const [, ...sources] of ancestors) {
			if (!sources.some((src) => sourceAllows(src, ours, theirs))) {
				return { embeddable: false, reason: `Its Content-Security-Policy says frame-ancestors ${sources.join(' ') || "'none'"}.` };
			}
		}
		return { embeddable: true };
	}
	const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
	if (xfo) {
		for (const value of xfo.split(',').map((v) => v.trim())) {
			if (value === 'deny') return { embeddable: false, reason: 'It sends X-Frame-Options: DENY.' };
			if (value === 'sameorigin' && ours.origin !== theirs.origin) {
				return { embeddable: false, reason: 'It sends X-Frame-Options: SAMEORIGIN.' };
			}
		}
	}
	return { embeddable: true };
}

/** Fetch `url`'s headers and say whether a page at `origin` may frame it. */
export async function checkFraming(url: string, origin: string): Promise<FrameCheck> {
	let res: Response;
	try {
		res = await fetchHeaders(url, FRAME_CHECK_TIMEOUT_MS);
	} catch {
		// Why it failed stays here: the answer should not map what this machine can reach.
		return { embeddable: null, reason: 'Could not reach the page to check it.' };
	}
	return framingVerdict(res.headers, new URL(res.url || url), new URL(origin));
}
