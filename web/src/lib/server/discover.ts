/**
 * Peer discovery over Tailscale.
 *
 * Extracted from the `/api/servers/discover` route so the usage aggregator can
 * reach the same set of machines without going through HTTP to reach itself.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServerInfo } from '$lib/types/servers';
import { APP_MARKER } from '$lib/constants';

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

function buildUrl(dnsName: string, port: string): string {
	return `https://${stripDot(dnsName)}:${port}`;
}

function hostnameFromDns(dnsName: string): string {
	return stripDot(dnsName).split('.')[0];
}

/** True only for a peer that answers as claude-mux. */
async function probe(url: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) return false;
		const data = (await res.json()) as { app?: string };
		return data.app === APP_MARKER;
	} catch {
		return false;
	}
}

export interface Discovery {
	servers: ServerInfo[];
	self: string;
	error?: string;
}

export async function discoverServers(port: string): Promise<Discovery> {
	let self: ServerInfo;
	let candidates: ServerInfo[];

	try {
		const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
			maxBuffer: 4 * 1024 * 1024
		});
		const status = JSON.parse(stdout) as TailscaleStatus;
		if (!status?.Self?.DNSName) throw new Error('tailscale status missing Self.DNSName');

		self = {
			hostname: hostnameFromDns(status.Self.DNSName),
			url: buildUrl(status.Self.DNSName, port)
		};
		candidates = Object.values(status.Peer ?? {})
			.filter((p) => p.Online && p.DNSName)
			.map<ServerInfo>((p) => ({
				hostname: hostnameFromDns(p.DNSName),
				url: buildUrl(p.DNSName, port)
			}));
	} catch (err) {
		const message = err instanceof Error ? err.message : 'tailscale CLI unavailable';
		return { servers: [], self: '', error: message };
	}

	const probes = await Promise.all(candidates.map((c) => probe(c.url)));
	const responders = candidates.filter((_, i) => probes[i]);

	const servers = [self, ...responders].sort((a, b) => a.hostname.localeCompare(b.hostname));
	return { servers, self: self.hostname };
}
