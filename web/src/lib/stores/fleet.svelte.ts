/**
 * Every machine in the fleet, read at once.
 *
 * The page talks only to the machine that served it (ADR 0004). That machine
 * follows every other one and keeps what each last said (its fleet state,
 * `src/server/fleet-state.ts`), and sends it on the page's own sessions
 * socket, which `sessionStore` reads; this store lays it beside the origin's
 * own sessions. A machine that is off keeps its last known sessions here,
 * with when it was last seen and when it is tried next. Acting on a remote
 * session's row goes through the origin's relay (`apiBase()`), and opening
 * one stays on this page at `/m/<host>/session/<target>`, whose calls take the
 * same way (`routeMachine()`, `sessionApi()`).
 *
 * `selected` is which machine the sidebar shows: 'all', or one machine's id.
 * It is a fleet preference (`fleetPrefsStore`), so every link and device
 * shows the same machines.
 */

import { browser } from '$app/environment';
import { onMount } from 'svelte';
import { fleetPrefsStore } from './fleet-prefs.svelte';
import { MACHINE_FILTER } from '$shared/fleet-prefs.js';
import { formatAgo } from '$lib/format';
import { sessionStore, type Session } from './sessions.svelte';
import { serverStore } from './servers.svelte';
import type { InboxTicket } from '$shared/types/ws-messages.js';
import type { ProjectReport } from '$shared/fleet-projects.js';
import type { ServerInfo } from '$lib/types/servers';
import { parseRef } from '$lib/split-refs';
import { relayBase } from '$lib/session-route';
import { VERSION } from '$shared/utils/version.js';
import { PROTOCOL, belowMinimum, protocolRefusal } from '$shared/fleet-protocol.js';

/** One machine's view: who it is, whether it answers, and what it holds. */
export interface Machine {
	server: ServerInfo;
	/** The host that served this page: its sessions are the ones we can act on here. */
	local: boolean;
	/** Whether it answers now. The origin is online while the page's socket is. */
	online: boolean;
	/** When it was last heard from (ms, the origin's clock); null for the origin or one never heard. */
	lastSeen: number | null;
	/** While offline, when the origin tries it next. */
	retryAt: number | null;
	version: string | null;
	/** The protocol it speaks (`src/fleet-protocol.ts`): 0 for one too old to say, null while unknown. */
	protocol: number | null;
	sessions: Session[];
	projects: string[];
	/** What it says about each project, to match it across machines. */
	projectReports: ProjectReport[];
	/** Tickets on GitHub waiting on a person, for that machine's repos. */
	inbox: InboxTicket[];
}

class FleetStore {
	private started = false;

	/** Every machine, this one first, then the others by name. */
	machines: Machine[] = $derived.by(() => {
		// Named as the tailnet knows it, even when the page was opened as localhost.
		const hostname = selfName();
		const selfId = sessionStore.selfId;
		const local: Machine = {
			server: { id: selfId, hostname, url: serverStore.current.url },
			local: true,
			online: sessionStore.connected,
			lastSeen: null,
			retryAt: null,
			// The page was built with its origin, so the origin runs what this bundle says.
			version: VERSION,
			protocol: PROTOCOL,
			sessions: sessionStore.sessions,
			projects: sessionStore.savedProjects,
			projectReports: sessionStore.projectReports,
			inbox: sessionStore.inbox
		};
		// Never this machine again, under another name; and never two rows under
		// one name, or the sidebar's keyed lists throw. Where two ids share a name
		// (a machine whose id changed), the one heard from last stands.
		const byName = new Map<string, (typeof sessionStore.fleet)[number]>();
		for (const m of sessionStore.fleet) {
			if (m.id === selfId || m.hostname === hostname) continue;
			const other = byName.get(m.hostname);
			const newer = (m.lastSeen ?? 0) > (other?.lastSeen ?? 0);
			if (!other || (m.online && !other.online) || (m.online === other.online && newer)) byName.set(m.hostname, m);
		}
		const others: Machine[] = [];
		for (const m of byName.values()) {
			others.push({
				server: { id: m.id, hostname: m.hostname, url: m.url },
				local: false,
				// Nothing reaches it while the page cannot reach its own origin.
				online: m.online && sessionStore.connected,
				lastSeen: m.lastSeen,
				retryAt: m.retryAt,
				version: m.version,
				protocol: m.protocol,
				sessions: m.sessions as Session[],
				projects: m.projects,
				projectReports: m.projectReports ?? [],
				inbox: m.inbox
			});
		}
		return [local, ...others];
	});

	/** 'all', or the id of the one machine the sidebar shows; 'all' while the one chosen is not in the fleet. */
	selected: string = $derived.by(() => {
		const chosen = fleetPrefsStore.get<string>(MACHINE_FILTER, 'all');
		return this.machines.some((m) => m.server.id === chosen) ? chosen : 'all';
	});

	/** The machines the sidebar is showing right now. */
	visible: Machine[] = $derived(
		this.selected === 'all' ? this.machines : this.machines.filter((m) => m.server.id === this.selected)
	);

	/** Whether there is more than this host to show. */
	fleet: boolean = $derived(this.machines.length > 1);

	/**
	 * Called once from the sidebar; safe to call again. Discovery is asked
	 * only for this machine's own tailnet name.
	 */
	start(): void {
		if (!browser || this.started) return;
		this.started = true;
		serverStore.init();
		void serverStore.refresh();
	}

	/** Another machine by the short name a session's route gives it. */
	remote(hostname: string): Machine | undefined {
		const name = hostname.toLowerCase();
		return this.machines.find((m) => !m.local && m.server.hostname.toLowerCase() === name);
	}

	/** Every machine this page knows the id of: the fleet the origin follows, then discovery's list. */
	servers(): ServerInfo[] {
		return [...this.machines.filter((m) => !m.local).map((m) => m.server), ...serverStore.servers];
	}

	/** Show one machine, by id, or 'all'. */
	select(id: string): void {
		void fleetPrefsStore.set(MACHINE_FILTER, id);
	}

	/** "Try now": have the origin reach an offline machine at once. */
	async retry(machine: Machine): Promise<void> {
		await fetch(`/api/fleet/${encodeURIComponent(machine.server.id)}/retry`, { method: 'POST' }).catch(() => {});
	}
}

export const fleetStore = new FleetStore();

/** The short name of this page's own machine, as session routes compare it. */
export function selfName(): string {
	return serverStore.self || serverStore.current.hostname;
}

/** A session's API from this page, `<base>/api/sessions/<id or target>`. */
export function sessionApiAt(base: string, id: string): string {
	return `${base}/api/sessions/${encodeURIComponent(id)}`;
}

/**
 * A session's API from this page by its ref (`target` here, `host@target`
 * elsewhere), reached the way its page reaches it (`relayBase()`).
 */
export function sessionApi(ref: string): string | null {
	const parsed = parseRef(ref);
	if (!parsed) return null;
	return sessionApiAt(relayBase(parsed.host, fleetStore.servers(), selfName()), parsed.target);
}

/**
 * The machine a session's route names (`/m/<host>/…`), for the pages that
 * show one: where its API is (`base`), its name when it is not this machine
 * (`remoteHost`), and, for another machine, what the origin last heard of it
 * (`machine`). Call it while a component initialises.
 */
export function routeMachine(host: () => string | null) {
	const base = $derived(relayBase(host(), fleetStore.servers(), selfName()));
	const remoteHost = $derived(base !== '' ? host() : null);
	const machine = $derived(remoteHost ? (fleetStore.remote(remoteHost) ?? null) : null);
	const serverUrl = $derived(machine?.server.url ?? null);
	const machineHost = $derived.by(() => {
		if (!remoteHost) return null;
		try {
			return new URL(serverUrl ?? '').hostname || remoteHost;
		} catch {
			return remoteHost;
		}
	});
	onMount(() => fleetStore.start());
	return {
		get base() {
			return base;
		},
		get remoteHost() {
			return remoteHost;
		},
		get machine() {
			return machine;
		},
		/** The name another machine's own ports (its dev servers) are reached by: its tailnet address. */
		get machineHost() {
			return machineHost;
		},
		/** A session by tmux target or id: this machine's from its indexes, another's from its broadcast. */
		session(target: string | null): Session | undefined {
			if (!target) return undefined;
			if (remoteHost) return machine?.sessions.find((s) => s.tmux_target === target || s.id === target);
			return sessionStore.sessionByTarget.get(target) ?? sessionStore.sessionById.get(target);
		}
	};
}

/**
 * Where a machine's API is reached from this page: this server for its own
 * sessions, and this server's relay (`/fleet/<id>`) for any other machine's.
 */
export function apiBase(machine: Machine): string {
	return machine.local ? '' : `/fleet/${encodeURIComponent(machine.server.id)}`;
}

/** "seen 3m ago", or "seen just now". */
export function seenLabel(lastSeen: number, now: number): string {
	const ago = formatAgo(lastSeen, now);
	return ago === 'now' ? 'seen just now' : `seen ${ago} ago`;
}

/** A machine's name as the page shows it. */
export function machineName(machine: Machine): string {
	return machine.server.hostname || 'this machine';
}

/** Its sessions whose pane is still there. */
export function liveCount(machine: Machine): number {
	return machine.sessions.filter((s) => s.pane_alive !== false).length;
}

/**
 * Whether a machine runs another claude-mux than this page: its version
 * differs, or it is known to be too old to report one. A machine not yet
 * heard from is not marked.
 */
export function versionDrifts(machine: Machine): boolean {
	return machine.version ? machine.version !== VERSION : machine.protocol === 0;
}

/** "offline, seen 3m ago", or "offline" for a machine never heard from. */
export function offlineLabel(machine: Machine, now: number): string {
	return machine.lastSeen ? `offline, ${seenLabel(machine.lastSeen, now)}` : 'offline';
}

/**
 * Why nothing can be done on a machine right now, or null when it answers.
 * Shown wherever an action on its sessions is turned off.
 */
export function offlineReason(machine: Machine, now: number): string | null {
	if (machine.online || machine.local) return null;
	const name = machineName(machine);
	return machine.lastSeen ? `${name} is offline (${seenLabel(machine.lastSeen, now)})` : `${name} is offline`;
}

/** Whether this page can act on a machine's sessions: it answers, and speaks enough for the relay. */
export function reachable(machine: Machine): boolean {
	return machine.local || (machine.online && !belowMinimum(machine.protocol));
}

/**
 * Why nothing can be done on a machine's sessions from this page, or null:
 * it is offline, or it runs a claude-mux too old for this one (whose relay
 * would refuse it, naming it the same way).
 */
export function blockedReason(machine: Machine, now: number): string | null {
	return offlineReason(machine, now) ?? protocolRefusal({ ...machine, hostname: machine.server.hostname });
}
