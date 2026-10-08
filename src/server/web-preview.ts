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
import { isAbsolute, relative } from 'path';
import { promisify } from 'util';
import { isLoopback } from '../utils/loopback.js';

const execFileAsync = promisify(execFile);

/** How long a candidate dev server gets to answer the HTML probe. */
const PROBE_TIMEOUT_MS = 1_000;
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

export interface TailnetInfo {
	/** This machine's tailnet name, e.g. `box.tail1234.ts.net`, or null without tailscale. */
	host: string | null;
	/** Local port → the HTTPS URL tailscale serve proxies to it. */
	serves: Record<number, string>;
}

/** What `GET /api/sessions/<id>/web` answers. */
export interface WebInfo {
	root: string;
	/** The URLs `.claude-mux.json` names. */
	urls: Record<string, string>;
	configError: string | null;
	detected: DevServer[];
	tailnet: TailnetInfo;
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

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Where to reach a server bound to `addresses` from this machine. */
function localUrl(port: number, addresses: string[]): string {
	if (addresses.some((a) => isWildcard(a) || isLoopback(a))) return `http://localhost:${port}/`;
	const a = addresses[0];
	return `http://${a.includes(':') ? `[${a}]` : a}:${port}/`;
}

/** Whether `url` answers with an HTML page within the probe timeout. */
async function servesHtml(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'follow' });
		void res.body?.cancel();
		return (res.headers.get('content-type') ?? '').includes('text/html');
	} catch {
		return false;
	}
}

/**
 * The listeners whose process works inside `root` and answers HTTP with HTML,
 * one per port, lowest port first. `exclude` leaves out a process (this
 * server, which may well run from the same repo).
 */
export async function detectDevServers(root: string, exclude = process.pid): Promise<DevServer[]> {
	if (process.platform !== 'linux') return [];
	let out: string;
	try {
		({ stdout: out } = await execFileAsync('ss', ['-ltnpH'], { timeout: 2_000 }));
	} catch {
		return [];
	}
	const byPort = new Map<number, Listener[]>();
	for (const l of parseListeners(out)) {
		if (l.pid === exclude) continue;
		byPort.set(l.port, [...(byPort.get(l.port) ?? []), l]);
	}
	const cwds = new Map<number, Promise<string | null>>();
	const cwdOf = (pid: number) => {
		if (!cwds.has(pid)) cwds.set(pid, readlink(`/proc/${pid}/cwd`).catch(() => null));
		return cwds.get(pid)!;
	};
	const found = await Promise.all(
		[...byPort].map(async ([port, socks]): Promise<DevServer | null> => {
			const cwd = await cwdOf(socks[0].pid);
			if (!cwd || !inside(root, cwd)) return null;
			const addresses = socks.map((s) => s.address);
			const url = localUrl(port, addresses);
			if (!(await servesHtml(url))) return null;
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
		const colon = hostPort.lastIndexOf(':');
		const host = hostPort.slice(0, colon);
		const httpsPort = hostPort.slice(colon + 1);
		const url = httpsPort === '443' ? `https://${host}` : `https://${host}:${httpsPort}`;
		if (!serves[local] || String(local) === httpsPort) serves[local] = url;
	}
	return serves;
}

let tailnetCache: { at: number; info: Promise<TailnetInfo> } | null = null;

async function readTailnet(): Promise<TailnetInfo> {
	const run = (args: string[]) =>
		execFileAsync('tailscale', args, { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 })
			.then(({ stdout }) => JSON.parse(stdout) as unknown)
			.catch(() => null);
	const [status, serve] = await Promise.all([run(['status', '--json']), run(['serve', 'status', '--json'])]);
	const dns = (status as { Self?: { DNSName?: string } } | null)?.Self?.DNSName;
	return {
		host: dns ? dns.replace(/\.$/, '') : null,
		serves: serve ? parseServeStatus(serve as ServeStatus) : {}
	};
}

/** This machine's tailnet name and serve mappings, empty without tailscale. */
export function tailnetInfo(): Promise<TailnetInfo> {
	const now = Date.now();
	if (!tailnetCache || now - tailnetCache.at > TAILNET_CACHE_MS) {
		tailnetCache = { at: now, info: readTailnet() };
	}
	return tailnetCache.info;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Whether one CSP source expression lets `ours` frame a page served from `theirs`. */
function sourceAllows(source: string, ours: URL, theirs: URL): boolean {
	const s = source.toLowerCase();
	if (s === '*') return true;
	if (s === "'self'") return ours.origin === theirs.origin;
	if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return ours.protocol === s || (s === 'http:' && ours.protocol === 'https:');
	const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^:/]+)(?::(\*|\d+))?(?:\/.*)?$/.exec(s);
	if (!m) return false;
	const [, scheme, host, port] = m;
	if (scheme && `${scheme}:` !== ours.protocol && !(scheme === 'http' && ours.protocol === 'https:')) return false;
	const hostname = ours.hostname.toLowerCase();
	if (host === '*') {
		// matches any host
	} else if (host.startsWith('*.')) {
		if (!hostname.endsWith(host.slice(1))) return false;
	} else if (host !== hostname) {
		return false;
	}
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
		res = await fetch(url, { signal: AbortSignal.timeout(FRAME_CHECK_TIMEOUT_MS), redirect: 'follow' });
		void res.body?.cancel();
	} catch (err) {
		return { embeddable: null, reason: err instanceof Error ? err.message : String(err) };
	}
	return framingVerdict(res.headers, new URL(res.url || url), new URL(origin));
}
