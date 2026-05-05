import { ReliableWebSocket } from './websocket-base.svelte';
import { createPersisted } from './persisted';
import { SessionsWsMessageSchema, type SystemStatsMessage } from '$shared/types/ws-messages.js';
import type { SessionAgent } from '$shared/db/index.js';

const savedProjectsStore = createPersisted<string[]>('claude-mux-projects', []);

export interface Screenshot {
	path: string;
	timestamp: number;
}

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface PendingQuestionItem {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options?: QuestionOption[];
}

export interface PendingQuestion {
	questions: PendingQuestionItem[];
	started_at: number;
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
	display_name?: string | null;
	agent?: SessionAgent;
	pending_question?: PendingQuestion | null;
}

/** Fields that change frequently and should trigger a session object replacement */
const VOLATILE_KEYS: (keyof Session)[] = [
	'state', 'current_action', 'prompt_text', 'last_update',
	'pane_title', 'pane_alive', 'chrome_active', 'linked_to', 'rc_url', 'queue_count', 'display_name'
];

/** Fast shallow comparison of two sessions on volatile fields + screenshots */
function sessionChanged(a: Session, b: Session): boolean {
	for (const key of VOLATILE_KEYS) {
		if (a[key] !== b[key]) return true;
	}
	// Screenshots: compare by length + last timestamp (avoids deep comparison)
	const aShots = a.screenshots;
	const bShots = b.screenshots;
	if ((aShots?.length ?? 0) !== (bShots?.length ?? 0)) return true;
	if (aShots && bShots && aShots.length > 0) {
		if (aShots[aShots.length - 1].timestamp !== bShots[bShots.length - 1].timestamp) return true;
	}
	// pending_question: compare by presence + started_at
	const aPQ = a.pending_question;
	const bPQ = b.pending_question;
	if ((aPQ == null) !== (bPQ == null)) return true;
	if (aPQ && bPQ && aPQ.started_at !== bPQ.started_at) return true;
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
export function stateColor(state: string): string {
	switch (state) {
		case 'permission':
		case 'waiting':
			return '#e74c3c';
		case 'idle':
			return '#f39c12';
		case 'busy':
			return '#27ae60';
		default:
			return '#666';
	}
}

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

/** Split pane title into leading symbol (✳, ⠐, etc.) and clean name */
export function splitPaneTitle(title: string): { symbol: string | null; isBraille: boolean; name: string } {
	const match = title.match(/^([\u2800-\u28FF\u2700-\u27BF\u2600-\u26FF\u2B50-\u2B55·•]+)\s*/);
	if (match) {
		const symbol = match[1];
		return { symbol, isBraille: /^[\u2800-\u28FF]+$/.test(symbol), name: title.slice(match[0].length) };
	}
	return { symbol: null, isBraille: false, name: title };
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
