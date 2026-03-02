import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';

export type {
	ResolvedDep,
	BeadsIssue,
	BeadsMessage,
	BeadsFilter,
	EpicGroup,
	BeadsStatus,
	EpicRelation
} from '$shared/types/beads.js';
import type { BeadsIssue, BeadsMessage, BeadsFilter, EpicGroup } from '$shared/types/beads.js';

/** Check if a non-closed/deferred issue has no active (non-closed) needs */
function hasNoActiveNeeds(issue: BeadsIssue): boolean {
	return issue.needs.every((n) => n.status === 'closed');
}

/** Sort tasks: children before dependencies, then in_progress → ready → blocked → by priority */
function sortTasks(tasks: BeadsIssue[]): BeadsIssue[] {
	return [...tasks].sort((a, b) => {
		// Direct children before transitive dependencies
		const relationOrder = (i: BeadsIssue): number =>
			i.epic_relation === 'dependency' ? 1 : 0;
		const ar = relationOrder(a);
		const br = relationOrder(b);
		if (ar !== br) return ar - br;

		const order = (i: BeadsIssue): number => {
			if (i.status === 'in_progress') return 0;
			if (i.status === 'open' && hasNoActiveNeeds(i)) return 1;
			if (i.status === 'open') return 2; // blocked
			return 3; // closed/deferred
		};
		const ao = order(a);
		const bo = order(b);
		if (ao !== bo) return ao - bo;
		return a.priority - b.priority;
	});
}

/**
 * BeadsStore - Real-time beads issues store with WebSocket support.
 * Connects per-project and receives updates when issues change.
 */
class BeadsStore extends ReliableWebSocket {
	issues = $state<BeadsIssue[]>([]);
	filter = $state<BeadsFilter>('active');
	currentProject = $state<string | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);

	/** O(1) lookup by issue ID — shared across all derivations */
	issueMap: Map<string, BeadsIssue> = $derived(new Map(this.issues.map((i) => [i.id, i])));

	/** View-filtered issues (active = not closed/deferred, all = everything) */
	viewFilteredIssues: BeadsIssue[] = $derived(
		this.filter === 'active'
			? this.issues.filter((i) => i.status !== 'closed' && i.status !== 'deferred')
			: this.issues
	);

	/** Filtered epics only — separate derived so non-epic changes don't trigger epic recomputation */
	private filteredEpics: BeadsIssue[] = $derived(
		this.viewFilteredIssues.filter((i) => i.issue_type === 'epic')
	);

	/** Epic groups with computed stats */
	epicGroups: EpicGroup[] = $derived.by(() => {
		const epics = this.filteredEpics;
		const allIssueMap = this.issueMap;
		const currentFilter = this.filter;

		const groups: EpicGroup[] = epics.map((epic) => {
			const childIds = epic.epic_children ?? [];
			// Resolve children from ALL issues (for completedCount) then filter for display
			const allChildren = childIds.map((id) => allIssueMap.get(id)).filter((i): i is BeadsIssue => !!i);

			// Single pass: compute counts and build display tasks simultaneously
			let completedCount = 0;
			let activeCount = 0;
			let blockedCount = 0;
			const displayTasks: BeadsIssue[] = [];

			for (const child of allChildren) {
				if (child.status === 'closed') {
					completedCount++;
					if (currentFilter !== 'active') displayTasks.push(child);
				} else if (child.status === 'deferred') {
					if (currentFilter !== 'active') displayTasks.push(child);
				} else {
					displayTasks.push(child);
					if (child.status === 'in_progress' || (child.status === 'open' && hasNoActiveNeeds(child))) {
						activeCount++;
					} else if (child.status === 'open') {
						blockedCount++;
					}
				}
			}

			return {
				epic,
				tasks: sortTasks(displayTasks),
				completedCount,
				totalCount: allChildren.length,
				activeCount,
				blockedCount
			};
		});

		// Sort epics: those with in_progress tasks first, then by priority, then alphabetically
		groups.sort((a, b) => {
			const aHasActive = a.tasks.some((t) => t.status === 'in_progress') ? 0 : 1;
			const bHasActive = b.tasks.some((t) => t.status === 'in_progress') ? 0 : 1;
			if (aHasActive !== bHasActive) return aHasActive - bHasActive;
			if (a.epic.priority !== b.epic.priority) return a.epic.priority - b.epic.priority;
			return a.epic.title.localeCompare(b.epic.title);
		});

		return groups;
	});

	/** Non-epic issues without a parent epic + issue count (single pass) */
	private orphanAndCount = $derived.by(() => {
		const filtered = this.viewFilteredIssues;
		const orphans: BeadsIssue[] = [];
		let nonEpicCount = 0;
		for (const i of filtered) {
			if (i.issue_type !== 'epic') {
				nonEpicCount++;
				if (!i.parent_epic_id) orphans.push(i);
			}
		}
		return { orphans, nonEpicCount };
	});

	orphanTasks: BeadsIssue[] = $derived(sortTasks(this.orphanAndCount.orphans));

	/** Count of non-epic filtered issues (for badge) */
	issueCount: number = $derived(this.orphanAndCount.nonEpicCount);

	protected getWsUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const project = encodeURIComponent(this.currentProject || '');
		return `${protocol}//${window.location.host}/api/beads/stream?project=${project}`;
	}

	protected getLogPrefix(): string {
		return '[beads]';
	}

	protected shouldReconnect(): boolean {
		// Only reconnect if we have a project set
		return !!this.currentProject;
	}

	protected handleMessage(event: MessageEvent): void {
		try {
			const data = JSON.parse(event.data) as BeadsMessage;
			if (data.issues) {
				this.issues = data.issues;
				this.error = null;
				// Update caches
				if (this.currentProject) {
					this.issueCache.set(this.currentProject, data.issues);
					this.saveToLocalStorage(this.currentProject, data.issues);
				}
			}
		} catch (err) {
			console.error('[beads] Failed to parse message:', err);
		}
	}

	protected onConnected(): void {
		this.loading = false;
		this.error = null;
	}

	protected onDisconnected(): void {
		// Keep issues visible during reconnection
	}

	private issueCache = new Map<string, BeadsIssue[]>();
	private readonly CACHE_KEY = 'claude-mux-beads-cache';

	/** Save issues to localStorage for persistence across refreshes */
	private saveToLocalStorage(project: string, issues: BeadsIssue[]): void {
		if (!browser) return;
		try {
			const cache = this.loadAllFromLocalStorage();
			cache[project] = issues;
			localStorage.setItem(this.CACHE_KEY, JSON.stringify(cache));
		} catch { /* quota exceeded or other error — ignore */ }
	}

	private loadAllFromLocalStorage(): Record<string, BeadsIssue[]> {
		if (!browser) return {};
		try {
			const raw = localStorage.getItem(this.CACHE_KEY);
			return raw ? JSON.parse(raw) : {};
		} catch { return {}; }
	}

	private loadFromLocalStorage(project: string): BeadsIssue[] | null {
		const cache = this.loadAllFromLocalStorage();
		return cache[project] ?? null;
	}

	/**
	 * Connect to a project's beads stream.
	 * When disconnecting (project=null), issues are cached in memory and localStorage
	 * so reopening the accordion is instant.
	 */
	setProject(project: string | null): void {
		if (project === this.currentProject) return;

		// Cache current issues before switching
		if (this.currentProject && this.issues.length > 0) {
			this.issueCache.set(this.currentProject, this.issues);
			this.saveToLocalStorage(this.currentProject, this.issues);
		}

		// Disconnect from previous project
		if (this.currentProject) {
			this.doDisconnect();
		}

		this.currentProject = project;
		this.error = null;

		if (project && browser) {
			// Restore cached issues immediately (memory first, then localStorage)
			const cached = this.issueCache.get(project) ?? this.loadFromLocalStorage(project);
			if (cached && cached.length > 0) {
				this.issues = cached;
				this.loading = false; // Show cached data immediately
			} else {
				this.issues = [];
				this.loading = true;
			}
			this.doConnect();
		} else if (!project) {
			// Keep issues in memory when collapsing — don't clear
		}
	}

	/**
	 * Set the filter type
	 */
	setFilter(filter: BeadsFilter): void {
		this.filter = filter;
	}

	/**
	 * Force refresh issues
	 */
	refresh(): void {
		if (this.currentProject) {
			this.forceReconnect();
		}
	}

	/**
	 * Manually connect (call from layout or page)
	 */
	connect(): void {
		if (this.currentProject && browser) {
			this.doConnect();
		}
	}

	/**
	 * Manually disconnect
	 */
	disconnect(): void {
		this.doDisconnect();
	}
}

export const beadsStore = new BeadsStore();
