import { json } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RequestHandler } from './$types';
import type { DiscoverResponse, ServerInfo } from '$lib/types/servers';

const execFileAsync = promisify(execFile);
const PORT = 3456;
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

function buildUrl(dnsName: string): string {
	return `https://${stripDot(dnsName)}:${PORT}`;
}

async function probe(url: string): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(`${url}/api/health`, { signal: ctrl.signal });
		if (!res.ok) return false;
		const data = (await res.json()) as { app?: string };
		return data.app === 'claude-mux';
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export const GET: RequestHandler = async () => {
	let status: TailscaleStatus;
	try {
		const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { maxBuffer: 4 * 1024 * 1024 });
		status = JSON.parse(stdout);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'tailscale CLI unavailable';
		return json({ servers: [], self: '', error: message } satisfies DiscoverResponse, { status: 500 });
	}

	const self: ServerInfo = {
		hostname: status.Self.HostName,
		url: buildUrl(status.Self.DNSName)
	};

	const candidates = Object.values(status.Peer ?? {})
		.filter((p) => p.Online && p.DNSName)
		.map<ServerInfo>((p) => ({ hostname: p.HostName, url: buildUrl(p.DNSName) }));

	const probes = await Promise.all(candidates.map((c) => probe(c.url)));
	const responders = candidates.filter((_, i) => probes[i]);

	const servers = [self, ...responders].sort((a, b) => a.hostname.localeCompare(b.hostname));
	return json({ servers, self: self.hostname } satisfies DiscoverResponse);
};
