import { ReliableWebSocket } from './websocket-base.svelte';
import { createPersisted } from './persisted';
import {
	SessionsWsMessageSchema,
	type SystemStatsMessage,
	type PaneChoice
} from '$shared/types/ws-messages.js';
import type { SessionAgent } from '$shared/db/index.js';
import type { QueuedMessageKind } from '$shared/server/message-queue.js';

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
	pane_title?: string | null;
	pane_alive?: boolean;
	screenshots?: Screenshot[];
	chrome_active?: boolean;
	linked_to?: string | null;
	rc_url?: string | null;
	queue_count?: number;
	/** Text of the next queued message, and who queued it. */
	queue_head_text?: string | null;
	queue_head_kind?: QueuedMessageKind | null;
	display_name?: string | null;
	/** Text in the pane's prompt box right now (live, never persisted). */
	draft_input?: string | null;
	/** Whether the user typed it, or Claude Code suggested it. */
	draft_kind?: 'typed' | 'suggestion' | null;
	/** Messages waiting in Claude Code's own queue, oldest first. */
	pane_queue?: string[];
	/** Numbered options a dialog is offering in the pane. Gate on `state`. */
	pane_choice?: PaneChoice | null;
	agent?: SessionAgent;
}

/** Fields that change frequently and should trigger a session object replacement */
const VOLATILE_KEYS: (keyof Session)[] = [
	'state', 'current_action', 'prompt_text', 'last_update',
	'pane_title', 'pane_alive', 'chrome_active', 'linked_to', 'rc_url', 'queue_count',
	'queue_head_text', 'queue_head_kind', 'display_name',
	'draft_input', 'draft_kind'
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
	// Pane choice: likewise a fresh object each tick, and it only changes when
	// the dialog does — compare the numbers, labels and which row is highlighted.
	const aOpts = a.pane_choice?.options;
	const bOpts = b.pane_choice?.options;
	if ((aOpts?.length ?? 0) !== (bOpts?.length ?? 0)) return true;
	if (a.pane_choice?.question !== b.pane_choice?.question) return true;
	if (
		aOpts &&
		bOpts &&
		aOpts.some((o, i) => o.label !== bOpts[i].label || o.selected !== bOpts[i].selected)
	)
		return true;
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
				this.diffAndUpdate(msg.sessions as Session[]);
				break;
			case 'systemStats':
				this.systemStats = { cpu: msg.cpu, ram: msg.ram, swap: msg.swap, ramTotal: msg.ramTotal, swapTotal: msg.swapTotal };
				break;
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

	loadSavedProjects(): void {
		this.savedProjects = savedProjectsStore.load();
	}

	saveProject(cwd: string): void {
		if (this.savedProjects.includes(cwd)) return;
		this.savedProjects = [...this.savedProjects, cwd];
		savedProjectsStore.save(this.savedProjects);
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

	removeProject(cwd: string): void {
		this.savedProjects = this.savedProjects.filter((p) => p !== cwd);
		savedProjectsStore.save(this.savedProjects);
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
	return session.display_name || session.tmux_target || session.id;
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
