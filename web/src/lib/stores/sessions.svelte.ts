import { ReliableWebSocket } from './websocket-base.svelte';
import { createPersisted } from './persisted';
import {
	SessionsWsMessageSchema,
	type SystemStatsMessage,
	type PaneChoice,
	type PaneActivity,
	type IssueInfo,
	type InboxTicket,
	type QueuedMessageInfo,
	type DeliveryInfo,
	type SubagentInfo
} from '$shared/types/ws-messages.js';
import type { SessionAgent } from '$shared/db/index.js';
import { indicatorStateOf, needsYouKind } from '$shared/session-state.js';
import { sessionDisplayName } from '$shared/session-notifications.js';
export { asking } from '$shared/session-notifications.js';

const savedProjectsStore = createPersisted<string[]>('claude-mux-projects', []);

export interface Screenshot {
	path: string;
	timestamp: number;
}

export type SystemStats = Omit<SystemStatsMessage, 'type' | 'timestamp'>;

export interface Session {
	v: number;
	id: string;
	pid: number;
	cwd: string;
	git_root: string | null;
	tmux_target: string | null;
	state: 'busy' | 'idle' | 'waiting' | 'permission';
	current_action: string | null;
	prompt_text: string | null;
	last_update: number;
	/** When the user's latest prompt started a turn; in this browser's clock on the local store. */
	turn_started_at?: number | null;
	/** When the latest turn ended for good, in the server's clock. */
	turn_completed_at?: number | null;
	/** When anyone last had the session open, in the server's clock; null when nobody has. */
	last_visited_at?: number | null;
	pane_title?: string | null;
	pane_alive?: boolean;
	screenshots?: Screenshot[];
	chrome_active?: boolean;
	linked_to?: string | null;
	rc_url?: string | null;
	/** Messages claude-mux holds for the pane, next out first. */
	queue?: QueuedMessageInfo[];
	/** What the queue and steers handed the pane lately, newest last. */
	delivered?: DeliveryInfo[];
	display_name?: string | null;
	/** Text in the pane's prompt box right now (live, never persisted). */
	draft_input?: string | null;
	/** Whether the user typed it, or Claude Code suggested it. */
	draft_kind?: 'typed' | 'suggestion' | null;
	/** Messages waiting in Claude Code's own queue, oldest first. */
	pane_queue?: string[];
	/** Numbered options a dialog is offering in the pane. Gate on `state`. */
	pane_choice?: PaneChoice | null;
	/** Claude Code's footer notice about its own update. */
	pane_update?: { kind: 'installed' | 'available' | 'failed'; text: string } | null;
	/** The spinner line while a turn runs, split into its parts; `started_at` is in this browser's clock. */
	pane_activity?: PaneActivity | null;
	/** Share of the context window in use as of the latest reply; null when unknown. */
	context_pct?: number | null;
	agent?: SessionAgent;
	/** Set when the maestro daemon started the session. */
	maestro_role?: string | null;
	maestro_issue?: number | null;
	/** Subagents running now, and those that finished within the last hour. */
	subagents?: SubagentInfo[];
	/** The issue that worker owns, as GitHub last described it. */
	issue?: IssueInfo | null;
}

/** Fields that change frequently and should trigger a session object replacement */
const VOLATILE_KEYS: (keyof Session)[] = [
	'state', 'current_action', 'prompt_text', 'last_update',
	'pane_title', 'pane_alive', 'chrome_active', 'linked_to', 'rc_url', 'display_name',
	'draft_input', 'draft_kind', 'context_pct',
	'turn_started_at', 'turn_completed_at', 'last_visited_at'
];

/** Fast shallow comparison of two sessions on volatile fields + screenshots */
function sessionChanged(a: Session, b: Session): boolean {
	for (const key of VOLATILE_KEYS) {
		if (a[key] !== b[key]) return true;
	}
	// Pane queue: a fresh array arrives every broadcast, so compare contents.
	const aQueue = a.pane_queue;
	const bQueue = b.pane_queue;
	if ((aQueue?.length ?? 0) !== (bQueue?.length ?? 0)) return true;
	if (aQueue && bQueue && aQueue.some((msg, i) => msg !== bQueue[i])) return true;
	// The server queue: likewise fresh each tick, and almost always empty.
	// Whole, since an edit changes one item's text and a reorder only its ids.
	if (JSON.stringify(a.queue ?? []) !== JSON.stringify(b.queue ?? [])) return true;
	// The delivery log only ever grows at the end.
	if ((a.delivered?.length ?? 0) !== (b.delivered?.length ?? 0)) return true;
	if (a.delivered?.length && a.delivered.at(-1)!.at !== b.delivered?.at(-1)?.at) return true;
	// Pane choice: likewise a fresh object each tick, and it only changes when
	// the dialog does. Every field counts — a ticked checkbox, a row turning
	// into a text field, a note the dialog adds — so compare the whole thing
	// rather than a shortlist that has to be kept in step with the reader.
	if ((a.pane_choice ?? null) !== (b.pane_choice ?? null)) {
		if (!a.pane_choice || !b.pane_choice) return true;
		if (JSON.stringify(a.pane_choice) !== JSON.stringify(b.pane_choice)) return true;
	}
	if ((a.pane_update?.text ?? null) !== (b.pane_update?.text ?? null)) return true;
	if (JSON.stringify(a.pane_activity ?? null) !== JSON.stringify(b.pane_activity ?? null)) return true;
	// Subagents: a fresh array each tick, so compare contents.
	if (JSON.stringify(a.subagents ?? []) !== JSON.stringify(b.subagents ?? [])) return true;
	// The issue arrives fresh each tick and changes only when GitHub's answer does.
	if (JSON.stringify(a.issue ?? null) !== JSON.stringify(b.issue ?? null)) return true;
	// Screenshots: compare by length + last timestamp (avoids deep comparison)
	const aShots = a.screenshots;
	const bShots = b.screenshots;
	if ((aShots?.length ?? 0) !== (bShots?.length ?? 0)) return true;
	if (aShots && bShots && aShots.length > 0) {
		if (aShots[aShots.length - 1].timestamp !== bShots[bShots.length - 1].timestamp) return true;
	}
	return false;
}

class SessionStore extends ReliableWebSocket {
	sessions = $state<Session[]>([]);
	systemStats = $state<SystemStats>({ cpu: 0, ram: 0, swap: 0, ramTotal: 0, swapTotal: 0 });
	paused = $state(false);
	/** Tickets on GitHub waiting on a person, for this machine's repos. */
	inbox = $state<InboxTicket[]>([]);

	// O(1) lookup by id and tmux_target — derived from sessions
	sessionById: Map<string, Session> = $derived(new Map(this.sessions.map(s => [s.id, s])));
	sessionByTarget: Map<string | null, Session> = $derived(
		new Map(this.sessions.filter(s => s.tmux_target).map(s => [s.tmux_target, s]))
	);

	// Saved projects from localStorage
	savedProjects = $state<string[]>([]);

	protected getWsUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${window.location.host}/api/sessions/stream`;
	}

	protected getLogPrefix(): string {
		return '[sessions]';
	}

	protected handleMessage(event: MessageEvent): void {
		if (this.paused) return;
		const parsed = SessionsWsMessageSchema.safeParse(JSON.parse(event.data));
		if (!parsed.success) return;

		const msg = parsed.data;
		switch (msg.type) {
			case 'sessions':
			case 'connected':
				this.toLocalClock(msg.sessions as Session[], msg.timestamp);
				this.diffAndUpdate(msg.sessions as Session[]);
				if (msg.projects) this.applyServerProjects(msg.projects);
				if (msg.settings) this.settings = msg.settings;
				if (msg.inbox && JSON.stringify(msg.inbox) !== JSON.stringify(this.inbox)) this.inbox = msg.inbox;
				break;
			case 'systemStats':
				this.systemStats = { cpu: msg.cpu, ram: msg.ram, swap: msg.swap, ramTotal: msg.ramTotal, swapTotal: msg.swapTotal };
				break;
		}
	}

	/** How far this browser's clock runs ahead of the server's, in ms. */
	private clockSkew: number | null = null;

	/**
	 * A turn's start arrives in the server's clock; the transcript counts up
	 * from it in this one. The skew is kept until it moves by more than the
	 * network's jitter, so the same start converts to the same instant and
	 * the count never steps back.
	 */
	private toLocalClock(sessions: Session[], serverNow: number): void {
		const skew = Date.now() - serverNow;
		if (this.clockSkew === null || Math.abs(skew - this.clockSkew) > 2000) this.clockSkew = skew;
		for (const s of sessions) {
			if (s.pane_activity?.started_at != null) s.pane_activity.started_at += this.clockSkew;
			// Shown as a running count only. The completion stays in the server's
			// clock: it is compared with the visit watermark, which is too.
			if (s.turn_started_at != null) s.turn_started_at += this.clockSkew;
		}
	}

	/**
	 * Diff incoming sessions against current state.
	 * Only replaces session objects that actually changed,
	 * preserving referential equality for unchanged ones.
	 */
	private diffAndUpdate(incoming: Session[]): void {
		const current = this.sessions;

		// Fast path: different count means structural change
		if (current.length !== incoming.length) {
			this.sessions = incoming;
			return;
		}

		// Build index of current sessions by id
		const currentById = new Map<string, Session>();
		for (const s of current) {
			currentById.set(s.id, s);
		}

		// Check if order changed or any IDs differ
		let orderChanged = false;
		for (let i = 0; i < incoming.length; i++) {
			if (incoming[i].id !== current[i].id) {
				orderChanged = true;
				break;
			}
		}

		if (orderChanged) {
			// IDs reordered — can still reuse unchanged objects
			const result: Session[] = new Array(incoming.length);
			for (let i = 0; i < incoming.length; i++) {
				const prev = currentById.get(incoming[i].id);
				result[i] = prev && !sessionChanged(prev, incoming[i]) ? prev : incoming[i];
			}
			this.sessions = result;
			return;
		}

		// Same order, same count — check each session
		let anyChanged = false;
		const result: Session[] = new Array(current.length);
		for (let i = 0; i < current.length; i++) {
			if (sessionChanged(current[i], incoming[i])) {
				result[i] = incoming[i];
				anyChanged = true;
			} else {
				result[i] = current[i]; // preserve reference
			}
		}

		if (anyChanged) {
			this.sessions = result;
		}
		// If nothing changed, don't touch this.sessions at all
	}

	connect(): void {
		this.doConnect();
	}

	disconnect(): void {
		this.doDisconnect();
	}

	togglePause(): void {
		this.paused = !this.paused;
	}

	/**
	 * Whether the server sends its own project list. Until the first broadcast
	 * says so, and on a server from before the list lived there, the browser's
	 * localStorage copy stands in.
	 */
	projectsFromServer = $state(false);
	/** This machine's settings as the server last sent them; null on an older server. */
	settings = $state<{ autoRemoteControl?: boolean } | null>(null);
	private get serverProjects(): boolean {
		return this.projectsFromServer;
	}
	private set serverProjects(value: boolean) {
		this.projectsFromServer = value;
	}

	loadSavedProjects(): void {
		this.savedProjects = savedProjectsStore.load();
	}

	/**
	 * Take the server's list. The first time, anything this browser still
	 * remembers on its own is handed up, so a list built before the move is
	 * not lost — and after that the browser copy is only a fallback.
	 */
	private applyServerProjects(projects: string[]): void {
		if (!this.serverProjects) {
			this.serverProjects = true;
			const known = new Set(projects);
			const local = savedProjectsStore.load().filter((cwd) => !known.has(cwd));
			for (const cwd of local) void this.pushProject(cwd);
			// Shown at once rather than after the round trip.
			this.savedProjects = [...projects, ...local];
			return;
		}
		this.savedProjects = projects;
	}

	private async pushProject(cwd: string): Promise<void> {
		try {
			await fetch('/api/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cwd })
			});
		} catch {
			// The next broadcast will say what the server has.
		}
	}

	saveProject(cwd: string): void {
		if (this.savedProjects.includes(cwd)) return;
		this.savedProjects = [...this.savedProjects, cwd];
		if (this.serverProjects) void this.pushProject(cwd);
		else savedProjectsStore.save(this.savedProjects);
	}

	/**
	 * Insert a session record locally before the watcher broadcast arrives.
	 * Lets navigation land with the session known to the store, eliminating
	 * the brief "session unknown" window after creation. Watcher reconciles
	 * later via diffAndUpdate — duplicates by id collapse to one.
	 */
	optimisticAdd(session: Session): void {
		if (this.sessions.some((s) => s.id === session.id)) return;
		this.sessions = [...this.sessions, session];
	}

	/** Flip a machine setting; the broadcast that follows confirms it. */
	setSetting(patch: { autoRemoteControl?: boolean }): void {
		this.settings = { ...(this.settings ?? {}), ...patch };
		void fetch('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		}).catch(() => {});
	}

	removeProject(cwd: string): void {
		this.savedProjects = this.savedProjects.filter((p) => p !== cwd);
		if (this.serverProjects) {
			void fetch('/api/projects', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cwd })
			}).catch(() => {});
		} else {
			savedProjectsStore.save(this.savedProjects);
		}
	}
}

export const sessionStore = new SessionStore();

// Helper functions
export type SessionGroup =
	| { type: 'pair'; main: Session; orchestrator: Session }
	| { type: 'single'; session: Session };

/**
 * Group sessions into linked pairs (main + orchestrator) and singles.
 * Pairs are identified by the orchestrator's linked_to field pointing to the main's id.
 */
export function groupSessions(sessions: Session[]): SessionGroup[] {
	// Map: mainId -> orchestrator session
	const orchestratorByMain = new Map<string, Session>();
	for (const s of sessions) {
		if (s.linked_to) {
			orchestratorByMain.set(s.linked_to, s);
		}
	}

	const result: SessionGroup[] = [];
	const processed = new Set<string>();

	for (const s of sessions) {
		if (processed.has(s.id)) continue;

		const orchestrator = orchestratorByMain.get(s.id);
		if (orchestrator && !processed.has(orchestrator.id)) {
			result.push({ type: 'pair', main: s, orchestrator });
			processed.add(s.id);
			processed.add(orchestrator.id);
		} else if (!s.linked_to) {
			result.push({ type: 'single', session: s });
			processed.add(s.id);
		}
	}

	// Remaining orphaned orchestrators (main was cleaned up)
	for (const s of sessions) {
		if (!processed.has(s.id)) {
			result.push({ type: 'single', session: s });
		}
	}

	return result;
}

export function getProjectColor(cwd: string): string {
	// Generate a consistent color based on path hash
	let hash = 0;
	for (let i = 0; i < cwd.length; i++) {
		hash = cwd.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 60%, 40%)`;
}

export function getSessionDisplayName(session: Session): string {
	return sessionDisplayName(session);
}

/** A maestro worker whose issue carries `needs-help`: it stopped to ask for a decision. */
export function needsHelp(session: Session): boolean {
	return session.issue?.labels.includes('needs-help') ?? false;
}

/** Whether a session is waiting on a person: a dialog in the pane, or a worker asking on GitHub. */
export function wantsHuman(session: Session): boolean {
	return needsYouKind(session) !== null || needsHelp(session);
}

/**
 * What leads the tab title: "(n) " for the live sessions waiting on a person
 * or whose last turn finished unseen, or nothing when there are none.
 */
export function attentionPrefix(sessions: Session[]): string {
	const n = sessions.filter((s) => s.pane_alive !== false && (wantsHuman(s) || indicatorStateOf(s) === 'done')).length;
	return n > 0 ? `(${n}) ` : '';
}

/** Tell the server someone is looking at the session, or rewind it to unread. */
export function postVisit(base: string, id: string, unread = false): void {
	void fetch(`${base}/api/sessions/${encodeURIComponent(id)}/visit`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ unread })
	}).catch(() => {});
}

export function findDeepestProject(path: string, projects: Iterable<string>): string | null {
	let best: string | null = null;
	for (const p of projects) {
		if (path === p || path.startsWith(p + '/')) {
			if (!best || p.length > best.length) best = p;
		}
	}
	return best;
}
