/**
 * Peer discovery over Tailscale.
 *
 * Extracted from the `/api/servers/discover` route so the usage aggregator and
 * the fleet relay can reach the same set of machines without going through
 * HTTP to reach themselves.
 */
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import type { ServerInfo } from '$lib/types/servers';
import { APP_MARKER } from '$lib/constants';
import { MACHINE_ID, listenPort } from '$lib/server/instance';
import { DEFAULT_SERVER_PORT } from '$shared/utils/paths.js';
import { tailscaleServes } from '$shared/server/web-preview.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 1500;

interface TailscalePeer {
	HostName: string;
	DNSName: string;
	Online: boolean;
}

interface TailscaleStatus {
	Self: TailscalePeer;
	Peer?: Record<string, TailscalePeer>;
}

function stripDot(dns: string): string {
	return dns.endsWith('.') ? dns.slice(0, -1) : dns;
}

function buildUrl(dnsName: string, port: number | string): string {
	return `https://${stripDot(dnsName)}:${port}`;
}

function hostnameFromDns(dnsName: string): string {
	return stripDot(dnsName).split('.')[0];
}

/**
 * The id of a machine that answers as claude-mux at `url`, or false. An older
 * peer answers without one; it is keyed by its name, since there is nothing
 * else to tell it apart by.
 */
async function probe(url: string): Promise<string | null | false> {
	try {
		const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) return false;
		const data = (await res.json()) as { app?: string; instance?: string };
		if (data.app !== APP_MARKER) return false;
		return data.instance ?? null;
	} catch {
		return false;
	}
}

/**
 * The tailnet URL of this server: the HTTPS port tailscale serve fronts it on,
 * or its own port when nothing fronts it.
 */
function selfUrl(dnsName: string, serves: Record<number, string>): string {
	return serves[listenPort()] ?? buildUrl(dnsName, listenPort());
}

/**
 * The ports another machine's claude-mux is looked for on. Nothing on the
 * tailnet says which port a peer serves, so these are the default and the one
 * this machine is fronted on — the same setup, most likely — and never the
 * port the page asking was opened on.
 */
function candidatePorts(self: string): number[] {
	const own = Number(new URL(self).port) || 443;
	return [...new Set([DEFAULT_SERVER_PORT, own])];
}

export interface Discovery {
	servers: ServerInfo[];
	self: string;
	error?: string;
}

/** The machines the last discovery found, by id, for the relay to look up. */
const known: Map<string, ServerInfo> = ((globalThis as { __claudeMuxMachines?: Map<string, ServerInfo> })
	.__claudeMuxMachines ??= new Map());

/**
 * Make machines known to the relay without discovery having seen them: the
 * fleet state restores the machines it followed before a restart, and one
 * that is off still answers 502 (unreachable), not 404 (unknown). Discovery's
 * own answer wins where both name a machine.
 */
export function rememberMachines(servers: readonly ServerInfo[]): void {
	for (const server of servers) if (!known.has(server.id)) known.set(server.id, server);
}

/** This machine's tailnet name, once discovery has run; its system hostname until then. */
export function selfName(): string {
	return known.get(MACHINE_ID)?.hostname ?? hostname().split('.')[0];
}

let inflight: Promise<Discovery> | null = null;

/** The machines on the tailnet that answer as claude-mux; callers that overlap share one run. */
export function discoverServers(): Promise<Discovery> {
	return (inflight ??= runDiscovery().finally(() => {
		inflight = null;
	}));
}

async function runDiscovery(): Promise<Discovery> {
	let self: ServerInfo;
	let candidates: ServerInfo[];

	try {
		const serves = tailscaleServes();
		const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
			maxBuffer: 4 * 1024 * 1024
		});
		const status = JSON.parse(stdout) as TailscaleStatus;
		if (!status?.Self?.DNSName) throw new Error('tailscale status missing Self.DNSName');

		self = {
			id: MACHINE_ID,
			hostname: hostnameFromDns(status.Self.DNSName),
			url: selfUrl(status.Self.DNSName, await serves)
		};
		const ports = candidatePorts(self.url);
		candidates = Object.values(status.Peer ?? {})
			.filter((p) => p.Online && p.DNSName)
			.flatMap((p) =>
				ports.map<ServerInfo>((port) => ({
					id: '',
					hostname: hostnameFromDns(p.DNSName),
					url: buildUrl(p.DNSName, port)
				}))
			);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'tailscale CLI unavailable';
		return { servers: [], self: '', error: message };
	}

	const probes = await Promise.all(candidates.map((c) => probe(c.url)));
	// One entry per machine: a second port or tailnet name leading to the same
	// machine (a host forwarding into its WSL) is dropped, and so is any name
	// that turns out to be this machine under another address.
	const seen = new Set<string>([MACHINE_ID]);
	const responders: ServerInfo[] = [];
	candidates.forEach((candidate, i) => {
		const result = probes[i];
		if (result === false) return;
		const id = result ?? candidate.hostname;
		if (seen.has(id)) return;
		seen.add(id);
		responders.push({ ...candidate, id });
	});

	const servers = [self, ...responders].sort((a, b) => a.hostname.localeCompare(b.hostname));
	// Added to, never cleared: a peer slow to answer one probe stays reachable
	// at its last address, and a machine that is really off answers 502.
	for (const server of servers) known.set(server.id, server);
	return { servers, self: self.hostname };
}

const REDISCOVER_MS = 10_000;
let lastRun = 0;

/**
 * Where to reach a machine's API, by its id: this server over loopback, any
 * other machine at the URL discovery found it on. An id discovery has not
 * seen sends it out again, at most every few seconds, so a machine that came
 * up since is found; null when it is still unknown.
 */
export async function machineUrl(id: string): Promise<string | null> {
	if (id === MACHINE_ID) return `http://127.0.0.1:${listenPort()}`;
	if (!known.has(id)) {
		// A run under way is waited for, so the sockets a page reopens together
		// all find the machine it turns up.
		if (inflight) await inflight;
		else if (Date.now() - lastRun > REDISCOVER_MS) {
			lastRun = Date.now();
			await discoverServers();
		}
	}
	return known.get(id)?.url ?? null;
}
