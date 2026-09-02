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
import { INSTANCE_ID } from '$lib/server/instance';

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

/**
 * The instance id of a peer that answers as claude-mux, or null. An older
 * peer answers without one; it is kept under its own name, since there is
 * nothing to tell it apart by.
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
	// One machine per instance: a second tailnet name leading to the same
	// process (a host forwarding into its WSL) is dropped, and so is any name
	// that turns out to be this process under another address.
	const seen = new Set<string>([INSTANCE_ID]);
	const responders: ServerInfo[] = [];
	candidates.forEach((candidate, i) => {
		const result = probes[i];
		if (result === false) return;
		if (result !== null) {
			if (seen.has(result)) return;
			seen.add(result);
		}
		responders.push(candidate);
	});

	const servers = [self, ...responders].sort((a, b) => a.hostname.localeCompare(b.hostname));
	return { servers, self: self.hostname };
}
