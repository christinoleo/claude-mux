/**
 * Every claude-mux on the tailnet, read at once.
 *
 * The page is served by one host and talks to that host's sessions through
 * `sessionStore`. The other hosts the server discovers over Tailscale each
 * get a read-only socket of their own here, carrying the same sessions
 * broadcast, so the sidebar can lay every machine's projects side by side.
 * Acting on a remote session — opening it, typing into it — is done on its
 * own host: the sidebar navigates there rather than proxying the terminal.
 *
 * `selected` is which machine the sidebar shows: 'all', or one hostname. It
 * is remembered per browser, since it is a viewing preference.
 */

import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';
import { createPersisted } from './persisted';
import { sessionStore, type Session } from './sessions.svelte';
import { serverStore } from './servers.svelte';
import { SessionsWsMessageSchema } from '$shared/types/ws-messages.js';
import type { ServerInfo } from '$lib/types/servers';

const selectedStore = createPersisted<string>('claude-mux-machine', 'all');

/** One machine's view: who it is, whether we can hear it, and what it holds. */
export interface Machine {
	server: ServerInfo;
	/** The host that served this page: its sessions are the ones we can act on here. */
	local: boolean;
	connected: boolean;
	sessions: Session[];
	projects: string[];
}

/** A read-only sessions socket to another host. */
class RemoteSessions extends ReliableWebSocket {
	sessions = $state<Session[]>([]);
	projects = $state<string[]>([]);

	constructor(readonly server: ServerInfo) {
		super();
	}

	connect(): void {
		this.doConnect();
	}

	disconnect(): void {
		this.doDisconnect();
	}

	protected getWsUrl(): string {
		const url = new URL(this.server.url);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.pathname = '/api/sessions/stream';
		url.search = '';
		return url.toString();
	}

	protected getLogPrefix(): string {
		return `[fleet:${this.server.hostname}]`;
	}

	protected handleMessage(event: MessageEvent): void {
		let raw: unknown;
		try {
			raw = JSON.parse(event.data);
		} catch {
			return;
		}
		const parsed = SessionsWsMessageSchema.safeParse(raw);
		if (!parsed.success) return;
		const msg = parsed.data;
		if (msg.type !== 'sessions' && msg.type !== 'connected') return;
		this.sessions = msg.sessions as Session[];
		if (msg.projects) this.projects = msg.projects;
	}
}

class FleetStore {
	selected = $state<string>('all');
	private remotes = $state<RemoteSessions[]>([]);
	private started = false;

	/** Every machine, this one first, then the others by name. */
	machines: Machine[] = $derived.by(() => {
		// Named as the tailnet knows it, even when the page was opened as localhost.
		const hostname = serverStore.self || serverStore.current.hostname;
		const local: Machine = {
			server: { hostname, url: serverStore.current.url },
			local: true,
			connected: sessionStore.connected,
			sessions: sessionStore.sessions,
			projects: sessionStore.savedProjects
		};
		// A page opened as localhost learns its tailnet name only when discovery
		// answers, and the cached server list already names this host by it.
		// sync() drops that remote a beat later; until then it must not stand
		// beside the local machine under the same name, or the sidebar's keyed
		// lists throw and the page stops updating until it is reloaded.
		const others = this.remotes
			.filter((r) => r.server.hostname !== hostname)
			.map<Machine>((r) => ({
				server: r.server,
				local: false,
				connected: r.connected,
				sessions: r.sessions,
				projects: r.projects
			}))
			.sort((a, b) => a.server.hostname.localeCompare(b.server.hostname));
		return [local, ...others];
	});

	/** The machines the sidebar is showing right now. */
	visible: Machine[] = $derived(
		this.selected === 'all'
			? this.machines
			: this.machines.filter((m) => m.server.hostname === this.selected)
	);

	/** Whether there is more than this host to show. */
	fleet: boolean = $derived(this.machines.length > 1);

	/**
	 * Start following the other hosts. Called once from the sidebar; safe to
	 * call again. Discovery is the server's, refreshed here so a machine that
	 * came up since the list was cached is picked up.
	 */
	start(): void {
		if (!browser || this.started) return;
		this.started = true;
		this.selected = selectedStore.load();
		serverStore.init();
		void serverStore.refresh();
	}

	/**
	 * Keep one socket per discovered host that is not this one. Runs from an
	 * effect in the sidebar so it follows the server list as it changes.
	 */
	sync(): void {
		const current = serverStore.current.hostname;
		const self = serverStore.self;
		const wanted = serverStore.servers.filter(
			(s) => s.hostname && s.url && s.hostname !== current && s.hostname !== self
		);
		const have = new Map(this.remotes.map((r) => [r.server.hostname, r]));
		let changed = false;
		for (const server of wanted) {
			const existing = have.get(server.hostname);
			if (existing && existing.server.url === server.url) continue;
			if (existing) existing.disconnect();
			const remote = new RemoteSessions(server);
			remote.connect();
			have.set(server.hostname, remote);
			changed = true;
		}
		for (const [hostname, remote] of have) {
			if (!wanted.some((s) => s.hostname === hostname)) {
				remote.disconnect();
				have.delete(hostname);
				changed = true;
			}
		}
		if (changed) this.remotes = [...have.values()];
	}

	select(hostname: string): void {
		this.selected = hostname;
		selectedStore.save(hostname);
	}
}

export const fleetStore = new FleetStore();
