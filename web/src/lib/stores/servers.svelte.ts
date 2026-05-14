import { browser } from '$app/environment';
import { createPersisted } from './persisted';
import { STORAGE_KEYS } from '$lib/constants';
import type { DiscoverResponse, ServerInfo } from '$lib/types/servers';

const cache = createPersisted<ServerInfo[]>(STORAGE_KEYS.servers, []);

function detectCurrent(): ServerInfo {
	if (!browser) return { hostname: '', url: '' };
	const host = window.location.host;
	const hostname = host.split(':')[0].split('.')[0];
	const url = `${window.location.protocol}//${host}`;
	return { hostname, url };
}

class ServerStore {
	current = $state<ServerInfo>({ hostname: '', url: '' });
	servers = $state<ServerInfo[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);

	init(): void {
		this.current = detectCurrent();
		const cached = cache.load();
		this.servers = cached.length > 0 ? cached : this.current.hostname ? [this.current] : [];
	}

	async refresh(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.error = null;
		try {
			const res = await fetch('/api/servers/discover');
			const data = (await res.json()) as DiscoverResponse;
			if (!res.ok || data.error) {
				this.error = data.error ?? `HTTP ${res.status}`;
				return;
			}
			this.servers = data.servers;
			cache.save(data.servers);
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'discover failed';
		} finally {
			this.loading = false;
		}
	}
}

export const serverStore = new ServerStore();
