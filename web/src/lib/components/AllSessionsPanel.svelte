<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		sessionStore,
		groupSessions,
		getSessionDisplayName,
		findDeepestProject,
		wantsHuman,
		postVisit,
		type Session
	} from '$lib/stores/sessions.svelte';
	import { apiBase, fleetStore, offlineReason, selfName, type Machine } from '$lib/stores/fleet.svelte';
	import { localRef, parseSessionPath, sessionPath } from '$lib/session-route';
	import SessionRow, { type RowMenuItem } from '$lib/components/SessionRow.svelte';
	import DiffBadge from '$lib/components/DiffBadge.svelte';
	import { PANES } from '$lib/side-panel/panes';
	import SubagentRow from '$lib/components/SubagentRow.svelte';
	import { agentView, childSummary, type AgentView } from '$shared/subagents.js';
	import { clock } from '$lib/stores/clock.svelte';
	import { tmuxPanesStore } from '$lib/stores/tmuxPanes.svelte';
	import { draftsStore } from '$lib/stores/drafts.svelte';
	import { attachmentsStore } from '$lib/stores/attachments.svelte';
	import { AGENTS, AGENT_IDS } from '$shared/agents.js';
	import type { SessionAgent } from '$shared/db/index.js';
	import type { TmuxPane } from '$lib/types/tmux';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { browser } from '$app/environment';
	import { longPress } from '$lib/actions/longPress';
	import MachineFilter from './MachineFilter.svelte';
	import RenameSessionDialog from './RenameSessionDialog.svelte';
	import FolderPicker from './FolderPicker.svelte';
	import NeedsYou from './NeedsYou.svelte';
	import type { InboxTicket } from '$shared/types/ws-messages.js';
	import { STORAGE_KEYS } from '$lib/constants';
	import { createPersisted } from '$lib/stores/persisted';
	import { fleetPrefsStore } from '$lib/stores/fleet-prefs.svelte';
	import { projectFoldKey } from '$shared/fleet-prefs.js';
	import { guessReport, mergeProjects, projectHue, projectInitials } from '$shared/fleet-projects.js';
	import * as Avatar from '$lib/components/ui/avatar';
	import { sidebarActionsStore, type ChordAction } from '$lib/stores/sidebarActions.svelte';
	import { splitStore } from '$lib/stores/split.svelte';
	import { formatRef, type PaneRef } from '$lib/split-refs';

	/**
	 * Projects folded shut. A fold is a fleet preference (`fleetPrefsStore`),
	 * kept under the project's fleet key, so a fold made on one link shows on
	 * every link and device, whichever machines the project's sessions are on.
	 * A project starts open, and a folded one turns amber when a session in it
	 * is asking for a person.
	 */
	function isProjectFolded(card: Card): boolean {
		return fleetPrefsStore.get(projectFoldKey(card.key), false);
	}
	function toggleProjectFold(card: Card) {
		void fleetPrefsStore.set(projectFoldKey(card.key), !isProjectFolded(card));
	}

	/**
	 * Subagents opened from this browser. A failed one keeps its row until it
	 * has been looked at; the newest few hundred are plenty to remember.
	 */
	const openedStore = createPersisted<string[]>('claude-mux-opened-agents', []);
	let opened = $state<Set<string>>(new Set());
	onMount(() => {
		opened = new Set(openedStore.load());
	});
	/** A row with no subagents gets this instead of reading the clock every tick. */
	const NO_AGENTS: AgentView = { rows: [], running: 0, folded: 0 };
	function agentsOf(s: Session): AgentView {
		return s.subagents?.length ? agentView(s.subagents, clock.now, opened) : NO_AGENTS;
	}
	function markOpened(agentId: string) {
		if (opened.has(agentId)) return;
		opened = new Set([...opened, agentId].slice(-300));
		openedStore.save([...opened]);
	}

	interface Props {
		onSessionSelect?: () => void;
		compact?: boolean;
	}

	let { onSessionSelect, compact = false }: Props = $props();

	// ── dialogs ────────────────────────────────────────────────────────────
	let showFolderBrowser = $state(false);
	let folderPicker = $state<FolderPicker | null>(null);
	let alertOpen = $state(false);
	let alertTitle = $state('');
	let alertMessage = $state('');
	let alertOnConfirm = $state<() => void>(() => {});
	let renameId = $state<string | null>(null);
	let menuOpen = $state(false);
	let searchOpen = $state(false);
	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);

	function showConfirm(title: string, message: string, onConfirm: () => void) {
		alertTitle = title;
		alertMessage = message;
		alertOnConfirm = onConfirm;
		alertOpen = true;
	}

	/**
	 * Which machine a new session should be made on, and where. `card` is the
	 * project it was opened from, so the dialog can also take it off the list:
	 * on a phone there is no hover to reveal a chip's close button.
	 */
	let agentPicker = $state<{ machine: Machine; cwd: string; card?: Card } | null>(null);

	/** The quiet chip whose menu is open, by project key; null when none is. */
	let quietMenu = $state<string | null>(null);
	/** The project whose "new session" menu (one entry per machine) is open. */
	let newMenu = $state<string | null>(null);

	function pickAgent(agent: SessionAgent) {
		const target = agentPicker;
		agentPicker = null;
		if (target) void newSessionInProject(target.machine, target.cwd, agent);
	}

	function removeFromPicker() {
		const target = agentPicker;
		agentPicker = null;
		if (target?.card) closeProject(target.card);
	}

	// ── the model: one card per project, across machines ────────────────────

	/** A live session in a project card, with where it sits under the root. */
	interface Row {
		session: Session;
		/** `web/` when the session runs below the project root; null at the root. */
		rel: string | null;
		orchestrator: boolean;
		/** A maestro worker, drawn under the session that runs its daemon. */
		worker?: boolean;
		/** On that session's row: how many workers sit under it. */
		workers?: number;
		/** On the last of those workers: its master, whose own subagents follow the workers. */
		trailing?: Session;
	}

	/** Where one machine holds a project, and what runs there. */
	interface Place {
		/** Its machine and root, unique across the fleet; the key its rows are drawn under. */
		key: string;
		machine: Machine;
		root: string;
		rows: Row[];
		dead: Session[];
		panes: TmuxPane[];
	}

	/** One project (`src/fleet-projects.ts`): the same codebase on every machine that holds it. */
	interface Card {
		key: string;
		name: string;
		initials: string;
		hue: number;
		/** Its icon's URL, through the relay when another machine holds it; null draws the initials. */
		icon: string | null;
		/** A session in it is asking for a person. */
		wants: boolean;
		/** The visible machines that hold it, in the fleet's order. */
		places: Place[];
		/** The places whose machine answers, where a session can start. */
		reachable: Place[];
		/** Whether it is held by more than one of them, so each place says which. */
		spans: boolean;
		/** Its live sessions, orchestrators not counted. */
		live: number;
		/** Each machine and root that holds it, one per line, for a tooltip. */
		where: string;
	}

	const tmuxPanes = $derived(tmuxPanesStore.panes);

	/**
	 * The session the page shows, as a ref: no host for this machine's, even
	 * when its route names it, so it compares equal to the row that opens it.
	 */
	const current = $derived.by((): PaneRef | null => {
		const ref = parseSessionPath($page.url.pathname)?.ref;
		return ref ? localRef(ref, fleetStore.servers(), selfName()) : null;
	});

	/** Whether a machine's session is the one on the page. */
	function isCurrent(machine: Machine, tmuxTarget: string | null): boolean {
		if (!current || !tmuxTarget || current.target !== tmuxTarget) return false;
		return machine.local
			? current.host === null
			: current.host?.toLowerCase() === machine.server.hostname.toLowerCase();
	}

	/**
	 * Whether a directory is nobody's project. The server knows the home
	 * directory and keeps such paths out of the list it sends; this is the
	 * browser's guess for a session whose cwd is not under any root — a path
	 * two segments deep (`/home/leo`, `/tmp`) or a mount point.
	 */
	function looksLikeRoot(cwd: string): boolean {
		const parts = cwd.split('/').filter(Boolean);
		if (parts.length <= 2) return true;
		return /^\/(?:mnt|media|Volumes)\/[^/]+$/.test(cwd);
	}

	function under(child: string, parent: string): boolean {
		return child === parent || child.startsWith(parent + '/');
	}

	/**
	 * The project roots of a machine: what the server remembers, plus any
	 * session directory under none of them (an older server, or a session
	 * that started this tick), reduced so no root sits under another.
	 */
	function rootsOf(machine: Machine): string[] {
		const roots = [...machine.projects];
		const extra = machine.sessions
			.map((s) => s.cwd)
			.filter((cwd): cwd is string => !!cwd && !looksLikeRoot(cwd))
			.sort((a, b) => a.length - b.length);
		for (const cwd of extra) {
			if (roots.some((r) => under(cwd, r))) continue;
			roots.push(cwd);
		}
		return roots;
	}

	/**
	 * Where under its project a session runs, short enough to read: the
	 * worktree directory name is scaffolding, and what distinguishes one
	 * worktree from the next is what comes after it.
	 */
	function relPath(cwd: string, root: string): string | null {
		if (cwd === root) return null;
		return cwd.slice(root.length + 1).replace(/^\.worktrees?\//, '');
	}

	/**
	 * A session nobody named is called after its tmux target, which says
	 * nothing; when it runs in a subdirectory, that subdirectory is the one
	 * thing that tells it apart, so it becomes the title.
	 */
	function rowTitle(row: Row): string {
		const s = row.session;
		if (!s.issue && !s.display_name && row.rel && !row.orchestrator) return row.rel;
		return getSessionDisplayName(s);
	}

	/**
	 * The chip under a row: what hangs off it ("1 worker · 2 agents"), else
	 * the path under a named session; a title made of the path needs none.
	 */
	function rowWhere(row: Row, agents: AgentView): string | null {
		if (row.orchestrator) return 'orch';
		const children = childSummary(row.workers ?? 0, agents);
		if (children) return children;
		return !row.worker && row.session.display_name && row.rel ? row.rel : null;
	}

	function agentHref(machine: Machine, target: string, agentId: string): string {
		return sessionPath(refOf(machine, target), `/agent/${encodeURIComponent(agentId)}`);
	}

	/** The tmux session a pane belongs to: `main` of `main:2.0`. */
	function tmuxSessionOf(s: Session): string | null {
		return s.tmux_target?.split(':')[0] ?? null;
	}

	/**
	 * The maestro daemon opens each worker as a window of the tmux session the
	 * master runs in, so a worker's master is the one non-worker session there.
	 * Workers move up under it; one whose master is gone stays where it was.
	 */
	function nestWorkers(rows: Row[]): Row[] {
		const workersOf = new Map<Row, Row[]>();
		const placed = new Set<Row>();
		for (const row of rows) {
			if (row.session.maestro_role !== 'worker') continue;
			const home = tmuxSessionOf(row.session);
			const master = rows.find(
				(r) => r !== row && !r.orchestrator && r.session.maestro_role !== 'worker' && tmuxSessionOf(r.session) === home
			);
			if (!master) continue;
			row.worker = true;
			workersOf.set(master, [...(workersOf.get(master) ?? []), row]);
			placed.add(row);
		}
		if (placed.size === 0) return rows;
		const out: Row[] = [];
		for (const row of rows) {
			if (placed.has(row)) continue;
			const workers = workersOf.get(row);
			out.push(workers ? { ...row, workers: workers.length } : row);
			if (workers) {
				workers.sort((a, b) => (a.session.maestro_issue ?? 0) - (b.session.maestro_issue ?? 0));
				out.push(...workers.slice(0, -1), { ...workers.at(-1)!, trailing: row.session });
			}
		}
		return out;
	}

	function rowsFor(sessions: Session[], root: string | null): Row[] {
		const rows: Row[] = [];
		for (const item of groupSessions(sessions)) {
			if (item.type === 'pair') {
				rows.push({ session: item.main, rel: root ? relPath(item.main.cwd, root) : null, orchestrator: false });
				rows.push({ session: item.orchestrator, rel: null, orchestrator: true });
			} else {
				rows.push({ session: item.session, rel: root ? relPath(item.session.cwd, root) : null, orchestrator: false });
			}
		}
		return nestWorkers(rows);
	}

	function matches(text: string): boolean {
		const q = query.trim().toLowerCase();
		return !q || text.toLowerCase().includes(q);
	}

	/** A machine's sessions and panes, put under the project roots they run in. */
	/** A machine's sessions and panes outside every project are a place with no root. */
	function placesOf(machine: Machine): { places: Map<string, Place>; loose: Place } {
		const roots = rootsOf(machine);
		const claudeTargets = new Set(machine.sessions.map((s) => s.tmux_target));
		// tmux panes are read from this host only.
		const panes = machine.local ? tmuxPanes.filter((p) => !claudeTargets.has(p.target)) : [];

		const byRoot = new Map<string, { live: Session[]; dead: Session[]; panes: TmuxPane[] }>();
		for (const root of roots) byRoot.set(root, { live: [], dead: [], panes: [] });
		const loose: Session[] = [];
		for (const s of machine.sessions) {
			const root = s.cwd ? findDeepestProject(s.cwd, roots) : null;
			if (!root) {
				loose.push(s);
				continue;
			}
			const bucket = byRoot.get(root)!;
			(s.pane_alive === false ? bucket.dead : bucket.live).push(s);
		}
		const loosePanes: TmuxPane[] = [];
		for (const pane of panes) {
			const root = pane.cwd ? findDeepestProject(pane.cwd, roots) : null;
			if (root) byRoot.get(root)!.panes.push(pane);
			else loosePanes.push(pane);
		}

		const places = new Map<string, Place>();
		for (const [root, bucket] of byRoot) {
			places.set(root, { key: placeKey(machine, root), machine, root, rows: rowsFor(bucket.live, root), dead: bucket.dead, panes: bucket.panes });
		}
		return {
			places,
			loose: {
				key: placeKey(machine, ''),
				machine,
				root: '',
				dead: [],
				rows: rowsFor(loose.filter((s) => matches(getSessionDisplayName(s))), null),
				panes: query.trim() ? loosePanes.filter((p) => matches(p.target)) : loosePanes
			}
		};
	}

	/** How a machine is told apart in the merge: its id, or its name before the id is known. */
	function machineKey(machine: Machine): string {
		return machine.server.id || machine.server.hostname;
	}

	function placeKey(machine: Machine, root: string): string {
		return `${machineKey(machine)}\0${root}`;
	}

	/** A project's icon, from the machine that has it. */
	function iconUrl(machine: Machine, root: string, token: string): string {
		return `${apiBase(machine)}/api/projects/icon?root=${encodeURIComponent(root)}&v=${encodeURIComponent(token)}`;
	}

	/**
	 * Every project in the fleet, matched across machines, with the sessions
	 * the visible machines run in it. Names and icons come from the whole
	 * fleet, so filtering to one machine does not change how a project looks.
	 */
	const model = $derived.by(() => {
		const visible = new Set(fleetStore.visible.map(machineKey));
		// Rows are laid out only for the machines shown; the rest lend the merge their roots alone.
		const machines = fleetStore.visible.map((machine) => ({ machine, ...placesOf(machine) }));
		const byKey = new Map(machines.map((m) => [machineKey(m.machine), m]));
		const projects = mergeProjects(
			fleetStore.machines.map((machine) => {
				const known = new Map(machine.projectReports.map((r) => [r.root, r]));
				return { id: machineKey(machine), reports: rootsOf(machine).map((root) => known.get(root) ?? guessReport(root)) };
			})
		);

		const cards: Card[] = [];
		const quiet: Card[] = [];
		for (const project of projects) {
			const places = project.places
				.filter((p) => visible.has(p.machineId))
				.map((p) => byKey.get(p.machineId)!.places.get(p.root)!);
			if (places.length === 0) continue;
			const icon = project.icon;
			const iconAt = icon && fleetStore.machines.find((m) => machineKey(m) === icon.machineId);
			const card: Card = {
				key: project.key,
				name: project.name,
				initials: projectInitials(project.name),
				hue: projectHue(project.name),
				icon: icon && iconAt ? iconUrl(iconAt, icon.root, icon.token) : null,
				wants: places.some((p) => p.rows.some((r) => wantsHuman(r.session))),
				places,
				reachable: places.filter((p) => p.machine.online),
				spans: new Set(places.map((p) => p.machine)).size > 1,
				live: places.reduce((n, p) => n + p.rows.filter((r) => !r.orchestrator).length, 0),
				where: places.map((p) => `${p.machine.server.hostname}:${p.root}`).join('\n')
			};
			if (query.trim()) {
				const hit = matches(card.name) || places.some((p) => p.rows.some((r) => matches(getSessionDisplayName(r.session))));
				if (!hit) continue;
			}
			// Nothing running — closed sessions included — is a chip, not a card.
			if (places.every((p) => p.rows.length === 0 && p.panes.length === 0)) quiet.push(card);
			else cards.push(card);
		}
		// By name, and nothing else: a project's place on the list is where the
		// reader's finger expects it. Sessions move within their card; the amber
		// dot says who wants a person without the card itself jumping.
		cards.sort((a, b) => a.name.localeCompare(b.name));
		quiet.sort((a, b) => a.name.localeCompare(b.name));

		const loose = machines
			.filter((m) => visible.has(machineKey(m.machine)))
			.map((m) => m.loose)
			.filter((l) => l.rows.length > 0 || l.panes.length > 0);
		return { cards, quiet, loose };
	});

	const anything = $derived(model.cards.length + model.quiet.length + model.loose.length > 0);

	/** The visible machines that are off, each said once above the list. */
	const offlineMachines = $derived(fleetStore.visible.filter((m) => offlineReason(m, clock.now)));

	/** Live sessions per machine, for the machine filter. */
	function liveCount(machine: Machine): number {
		return machine.sessions.filter((s) => s.pane_alive !== false).length;
	}

	/** Whether a session there wants a person; never on an offline machine, whose dialogs may be long answered. */
	function machineWants(machine: Machine): boolean {
		if (!machine.online) return false;
		return machine.sessions.some((s) => s.pane_alive !== false && wantsHuman(s));
	}

	// ── labels ───────────────────────────────────────────────────────────────
	onMount(() => {
		fleetStore.start();
		const unsubscribe = tmuxPanesStore.subscribe();
		return () => unsubscribe?.();
	});

	$effect(() => {
		if (searchOpen) searchInput?.focus();
	});

	function detectPaneAgent(command: string): SessionAgent | null {
		const cmd = command.toLowerCase();
		for (const id of AGENT_IDS) if (cmd.includes(id)) return id;
		return null;
	}

	// ── actions ──────────────────────────────────────────────────────────────

	/** How a split names this session: `target`, or `host@target` off this machine. */
	function refOf(machine: Machine, tmuxTarget: string): PaneRef {
		return { host: machine.local ? null : machine.server.hostname, target: tmuxTarget };
	}

	/** The session the page shows now, as a pane ref, for starting a split beside it. */
	function currentRef(): PaneRef | null {
		if (splitStore.active) return splitStore.pane(splitStore.focus);
		return current;
	}

	/**
	 * Open a session. With a split on, it goes to the focused pane (⌥ for the
	 * other); without one, ⌥ opens it beside the current session as a split,
	 * and a plain click goes to the session, on this page whichever machine
	 * it is on.
	 */
	function openSession(machine: Machine, tmuxTarget: string, other = false) {
		const ref = refOf(machine, tmuxTarget);
		if (splitStore.active) {
			splitStore.openIn(other ? 'other' : 'focus', ref, currentRef());
			onSessionSelect?.();
			return;
		}
		if (other && current) {
			splitStore.splitWith(ref, currentRef());
			onSessionSelect?.();
			return;
		}
		goToSession(machine, tmuxTarget);
	}

	/** Go to a session's page: `/m/<host>/session/…` for another machine's. */
	function goToSession(machine: Machine, tmuxTarget: string, query = '') {
		goto(`${sessionPath(refOf(machine, tmuxTarget))}${query}`);
		onSessionSelect?.();
	}

	/**
	 * The row's right-click menu: open the session with one of its side
	 * panel's panes. Left off during a split, which a page load would end.
	 */
	function panelMenu(machine: Machine, tmuxTarget: string): RowMenuItem[] {
		return PANES.map((pane) => ({
			label: `Open ${pane.label.toLowerCase()}`,
			icon: pane.icon,
			run: () => goToSession(machine, tmuxTarget, `?panel=${pane.kind}`)
		}));
	}

	function handleRowClick(e: MouseEvent, machine: Machine, session: Session) {
		e.preventDefault();
		if (e.detail >= 2 && machine.local) {
			renameId = session.id;
			return;
		}
		if (session.tmux_target) openSession(machine, session.tmux_target, e.altKey);
	}

	/** Which pane, if any, shows this session — for the row's A/B tag. */
	function paneTag(machine: Machine, tmuxTarget: string | null): 'A' | 'B' | null {
		if (!tmuxTarget || !splitStore.active) return null;
		const side = splitStore.sideOf(refOf(machine, tmuxTarget));
		return side === 'a' ? 'A' : side === 'b' ? 'B' : null;
	}

	/**
	 * Rows drag only under a mouse. A finger's long press is the rename (and
	 * the agent picker) here, and on the browsers that start a native drag
	 * from the same hold the two fight over it — for a split no phone is wide
	 * enough to show anyway (see MIN_PANE_PX).
	 */
	const canDrag = browser && window.matchMedia('(pointer: fine)').matches;

	/** A row leaves as a pane ref; the panes and the page's right edge catch it. */
	function dragStart(e: DragEvent, machine: Machine, tmuxTarget: string) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData('text/claude-mux-session', formatRef(refOf(machine, tmuxTarget)));
		e.dataTransfer.effectAllowed = 'link';
		splitStore.dragging = true;
	}
	function dragEnd() {
		splitStore.dragging = false;
	}

	function killSessionReq(machine: Machine, s: Session) {
		return fetch(`${apiBase(machine)}/api/sessions/${encodeURIComponent(s.id)}/kill`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pid: s.pid, tmux_target: s.tmux_target })
		});
	}

	function killSession(machine: Machine, s: Session) {
		showConfirm('Kill session', `Kill “${getSessionDisplayName(s)}”?`, () => {
			void killSessionReq(machine, s);
		});
	}

	function sweepDead(machine: Machine, dead: Session[]) {
		for (const s of dead) void killSessionReq(machine, s);
	}

	/** Close a project wherever the list shows it: its sessions killed, its folder taken off each machine's list. */
	function closeProject(card: Card) {
		const live = card.live;
		const msg =
			live > 0
				? `Kill ${live} session${live === 1 ? '' : 's'} in ${card.name} and remove the project?`
				: `Remove ${card.name} from the list? Its sessions are gone; the folder stays.`;
		showConfirm('Close project', msg, async () => {
			await Promise.all(
				card.places.map(async ({ machine, root, rows, dead }) => {
					const sessions = [...rows.filter((r) => !r.orchestrator).map((r) => r.session), ...dead];
					await Promise.all(sessions.map((s) => killSessionReq(machine, s)));
					if (machine.local) sessionStore.removeProject(root);
					else
						void fetch(`${apiBase(machine)}/api/projects`, {
							method: 'DELETE',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ cwd: root })
						});
				})
			);
		});
	}

	async function newSessionInProject(machine: Machine, cwd: string, agent: SessionAgent = 'claude', prompt?: string) {
		const res = await fetch(`${apiBase(machine)}/api/projects/new-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd, agent, prompt })
		});
		const data = await res.json();
		if (!data.ok) {
			alert(`Failed to create session: ${data.detail || data.error || 'Unknown error'}`);
			return;
		}
		if (machine.local) {
			sessionStore.saveProject(cwd);
			if (data.record) sessionStore.optimisticAdd(data.record);
		}
		const tmuxTarget = data.tmuxTarget || data.session + ':0.0';
		// Another machine's broadcast lists only Claude sessions, so a page here
		// could not show any other agent's pane: that one opens on its machine.
		if (!machine.local && agent !== 'claude') {
			window.location.href = `${machine.server.url}/session/${encodeURIComponent(tmuxTarget)}`;
			return;
		}
		openSession(machine, tmuxTarget);
	}

	/** The machine “Nova” acts on: the one filtered to, or this one. */
	const actingMachine = $derived(
		fleetStore.visible.length === 1 ? fleetStore.visible[0] : fleetStore.machines[0]
	);

	/** Work a wayfinder ticket: a fresh session in its repo, handed the ticket. */
	function startTicket(machine: Machine, ticket: InboxTicket) {
		void newSessionInProject(machine, ticket.git_root, 'claude', `/mattpocock-skills:wayfinder ${ticket.url}`);
	}

	/** The machine the folder picker is browsing, through the relay when it is another. */
	let pickerMachine = $state<Machine | null>(null);

	function newProject() {
		pickerMachine = actingMachine;
		void folderPicker?.openAt('~', apiBase(actingMachine));
	}

	async function closeChrome() {
		await fetch('/api/chrome', { method: 'DELETE' });
	}

	const RESET_KEEP_KEYS = new Set<string>([STORAGE_KEYS.lastSession]);

	function resetLocalStorage() {
		showConfirm(
			'Reset local data',
			'This clears preferences and cached data in this browser. Your projects stay on the server. The page will reload.',
			() => {
				for (let i = localStorage.length - 1; i >= 0; i--) {
					const key = localStorage.key(i);
					if (key && key.startsWith('claude-mux-') && !RESET_KEEP_KEYS.has(key)) {
						localStorage.removeItem(key);
					}
				}
				window.location.reload();
			}
		);
	}

	/** The rare actions, behind the menu; the same list feeds the chord menu. */
	const menuActions: ChordAction[] = $derived([
		{ label: 'Usage', icon: 'mdi:chart-line', run: () => void goto('/usage') },
		{ label: 'Close Chrome', icon: 'mdi:google-chrome', run: () => void closeChrome() },
		{ label: 'Refresh', icon: 'mdi:refresh', run: () => location.reload() },
		{
			label: sessionStore.paused ? 'Resume updates' : 'Pause updates',
			icon: sessionStore.paused ? 'mdi:play' : 'mdi:pause',
			run: () => sessionStore.togglePause(),
			variant: sessionStore.paused ? 'destructive' : 'secondary'
		},
		// Only offered when the server says where it stands; an older one does not.
		...(sessionStore.settings
			? [
					{
						label: sessionStore.settings.autoRemoteControl
							? 'Remote Control on new sessions: on'
							: 'Remote Control on new sessions: off',
						icon: sessionStore.settings.autoRemoteControl
							? 'mdi:cellphone-link'
							: 'mdi:cellphone-link-off',
						run: () =>
							sessionStore.setSetting({
								autoRemoteControl: !sessionStore.settings?.autoRemoteControl
							})
					}
				]
			: []),
		{ label: 'Reset data', icon: 'mdi:database-refresh', run: () => resetLocalStorage(), danger: true }
	]);

	$effect(() => {
		sidebarActionsStore.set([
			...menuActions,
			{ label: 'New project', icon: 'mdi:plus', run: () => newProject() }
		]);
	});
</script>

{#snippet sessionRow(machine: Machine, row: Row)}
	{#if row.worker}
		<!-- A worker hangs off its master on a solid violet thread, and its own
		     subagents ride inside that thread. -->
		<div class="thread worker">{@render rowWithAgents(machine, row)}</div>
		<!-- A master's own subagents come after its workers, as in the design. -->
		{#if row.trailing}{@render agentThread(machine, row.trailing, agentsOf(row.trailing))}{/if}
	{:else}
		{@render rowWithAgents(machine, row)}
	{/if}
{/snippet}

{#snippet agentThread(machine: Machine, s: Session, agents: AgentView)}
	{#if agents.rows.length > 0 && s.tmux_target}
		<div class="thread agents">
			{#each agents.rows as agent (agent.id)}
				{@const href = agentHref(machine, s.tmux_target, agent.id)}
				<SubagentRow
					{agent}
					{href}
					active={$page.url.pathname === href}
					onclick={() => {
						markOpened(agent.id);
						onSessionSelect?.();
					}}
				/>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet rowWithAgents(machine: Machine, row: Row)}
	{@const s = row.session}
	{@const agents = agentsOf(s)}
	{@const isActive = isCurrent(machine, s.tmux_target)}
	{@const draftKey = s.tmux_target && !isActive ? formatRef(refOf(machine, s.tmux_target)) : null}
	<SessionRow
		session={s}
		title={rowTitle(row)}
		where={rowWhere(row, agents)}
		href={sessionPath(refOf(machine, s.tmux_target ?? ''))}
		hint={(machine.local ? 'Double-click or long-press to rename' : `On ${machine.server.hostname}`) + (canDrag ? ' · ⌥-click or drag to open side by side' : '')}
		active={isActive}
		tag={paneTag(machine, s.tmux_target)}
		orchestrator={row.orchestrator}
		worker={row.worker}
		draft={draftKey ? draftsStore.preview(draftKey) : ''}
		staged={draftKey ? attachmentsStore.count(draftKey) : 0}
		draggable={canDrag && !!s.tmux_target}
		onkill={machine.local && !compact ? () => killSession(machine, s) : null}
		onmarkunread={isActive || paneTag(machine, s.tmux_target) ? null : () => postVisit(apiBase(machine), s.id, true)}
		onclick={(e) => handleRowClick(e, machine, s)}
		onlongpress={() => { if (machine.local) renameId = s.id; }}
		ondragstart={(e) => s.tmux_target && dragStart(e, machine, s.tmux_target)}
		ondragend={dragEnd}
		menu={s.tmux_target && !splitStore.active ? panelMenu(machine, s.tmux_target) : []}
	>
		{#snippet meta()}<DiffBadge changes={s.changes} />{/snippet}
	</SessionRow>
	{#if !row.workers}{@render agentThread(machine, s, agents)}{/if}
{/snippet}

{#snippet paneRow(machine: Machine, pane: TmuxPane)}
	{@const isActive = isCurrent(machine, pane.target)}
	{@const detected = detectPaneAgent(pane.command || '')}
	{@const meta = detected ? AGENTS[detected] : null}
	<a
		href="/session/{encodeURIComponent(pane.target)}"
		class="row"
		class:cur={isActive}
		draggable={canDrag ? 'true' : 'false'}
		ondragstart={(e) => dragStart(e, machine, pane.target)}
		ondragend={dragEnd}
		onclick={(e) => { e.preventDefault(); openSession(machine, pane.target, e.altKey); }}
	>
		<span class="st">
			<iconify-icon icon={meta?.icon ?? 'mdi:console-line'} style={meta ? `color:${meta.color}` : ''}></iconify-icon>
		</span>
		<span class="name mono">{pane.target}</span>
		<span class="meta"><span class="when">{meta?.label ?? pane.command}</span></span>
		<span class="ctx none"></span>
	</a>
{/snippet}

{#snippet tile(card: Card)}
	<!-- The project's icon, or its initials on its own hue: the same on every machine and link. -->
	<Avatar.Root class="ptile" style="--h:{card.hue}">
		{#if card.icon}<Avatar.Image src={card.icon} alt="" class="ptile-img" />{/if}
		<Avatar.Fallback class="ptile-init">{card.initials}</Avatar.Fallback>
	</Avatar.Root>
{/snippet}

{#snippet placeRows(place: Place, labelled: boolean)}
	{@const offline = offlineReason(place.machine, clock.now)}
	<!-- An offline machine's rows stay, dimmed and out of reach, until it answers again. -->
	<div class="place" class:off={!!offline} inert={!!offline}>
		{#if labelled}
			<div class="pmachine" title={offline ?? (place.root || undefined)}>
				<span class="dot" class:off={!place.machine.online}></span>{place.machine.server.hostname || 'this machine'}
			</div>
		{/if}
		{#each place.rows as row (row.session.id)}
			{@render sessionRow(place.machine, row)}
		{/each}
		{#each place.panes as pane (pane.target)}
			{@render paneRow(place.machine, pane)}
		{/each}
		{#if place.dead.length > 0}
			<div class="dead">
				<span class="n">{place.dead.length}</span>
				{place.dead.length === 1 ? 'closed session' : 'closed sessions'}
				{#if place.machine.local}
					<button type="button" class="sweep" onclick={() => sweepDead(place.machine, place.dead)}>clear</button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet projectCard(card: Card)}
	{@const pfolded = isProjectFolded(card)}
	{@const reachable = card.reachable}
	<section class="card proj" class:wants={card.wants} class:pfolded>
		<div class="proj-h">
			<button
				type="button"
				class="pfold"
				aria-expanded={!pfolded}
				title={pfolded ? 'Show this project' : 'Fold this project'}
				onclick={() => toggleProjectFold(card)}
			>
				{@render tile(card)}
				<span class="pname" title={card.where}>{card.name}</span>
				{#if pfolded}<iconify-icon class="pchev" icon="mdi:chevron-right"></iconify-icon>{/if}
				<span class="pcount">{card.live}</span>
			</button>
			{#if reachable.length === 1}
				{@const place = reachable[0]}
				<button
					type="button"
					class="pbtn"
					title="New session here (right-click or hold for another agent)"
					onclick={() => void newSessionInProject(place.machine, place.root)}
					oncontextmenu={(e) => { e.preventDefault(); agentPicker = { machine: place.machine, cwd: place.root, card }; }}
					use:longPress={{ onTrigger: () => (agentPicker = { machine: place.machine, cwd: place.root, card }) }}
				>
					<iconify-icon icon="mdi:plus"></iconify-icon>
				</button>
			{:else if reachable.length > 1}
				<!-- Held by several machines: say which one the session starts on. -->
				<Popover.Root open={newMenu === card.key} onOpenChange={(o) => (newMenu = o ? card.key : null)}>
					<Popover.Trigger class="pbtn" title="New session on…">
						<iconify-icon icon="mdi:plus"></iconify-icon>
					</Popover.Trigger>
					<Popover.Content class="menu" align="end" sideOffset={6}>
						{#each reachable as place (place.key)}
							<button type="button" class="mitem" title={place.root} onclick={() => { newMenu = null; agentPicker = { machine: place.machine, cwd: place.root, card }; }}>
								<iconify-icon icon="mdi:plus"></iconify-icon>New session on {place.machine.server.hostname || 'this machine'}
							</button>
						{/each}
					</Popover.Content>
				</Popover.Root>
			{/if}
			<button type="button" class="pbtn pclose" title="Close project" onclick={() => closeProject(card)}>
				<iconify-icon icon="mdi:close"></iconify-icon>
			</button>
		</div>
		{#if !pfolded}
			{#each card.places as place (place.key)}
				{#if !card.spans || place.rows.length + place.panes.length + place.dead.length > 0}
					{@render placeRows(place, card.spans)}
				{/if}
			{/each}
		{/if}
	</section>
{/snippet}

<div class="panel" class:compact>
	<header class="card head">
		<MachineFilter live={liveCount} wants={machineWants} />
		<button type="button" class="ghost" class:lit={searchOpen} title="Find a session" onclick={() => { searchOpen = !searchOpen; if (!searchOpen) query = ''; }}>
			<iconify-icon icon="mdi:magnify"></iconify-icon>
		</button>
		<Popover.Root bind:open={menuOpen}>
			<Popover.Trigger class="ghost" title="More">
				<iconify-icon icon="mdi:dots-horizontal"></iconify-icon>
			</Popover.Trigger>
			<Popover.Content class="menu" align="end" sideOffset={6}>
				{#each menuActions as action (action.label)}
					<button type="button" class="mitem" class:danger={action.danger} onclick={() => { menuOpen = false; action.run(); }}>
						<iconify-icon icon={action.icon}></iconify-icon>{action.label}
					</button>
				{/each}
			</Popover.Content>
		</Popover.Root>
		<button type="button" class="new" title="New project or session" onclick={newProject}>
			<iconify-icon icon="mdi:plus"></iconify-icon>New
		</button>
	</header>

	{#if searchOpen}
		<input
			bind:this={searchInput}
			bind:value={query}
			class="search"
			type="search"
			placeholder="Project or session…"
			onkeydown={(e) => { if (e.key === 'Escape') { searchOpen = false; query = ''; } }}
		/>
	{/if}


	<div class="list">
		{#if !query.trim()}
			<NeedsYou machines={fleetStore.visible} fleet={fleetStore.fleet} onOpen={(m, t) => openSession(m, t)} onStart={startTicket} />
		{/if}
		{#if !anything}
			<div class="empty">
				{#if query.trim()}
					Nothing matches “{query}”.
				{:else}
					No sessions yet. <button type="button" class="link" onclick={newProject}>Open a project</button> to start one.
				{/if}
			</div>
		{/if}
		{#each offlineMachines as machine (machine.server.hostname)}
			<div class="offline" role="status">
				<iconify-icon icon="mdi:lan-disconnect"></iconify-icon>
				<span class="why">{offlineReason(machine, clock.now)}</span>
				{#if machine.retryAt && machine.retryAt > clock.now}
					<span class="next">retry in {Math.ceil((machine.retryAt - clock.now) / 1000)}s</span>
				{/if}
				<Button variant="outline" size="sm" class="try" onclick={() => void fleetStore.retry(machine)}>Try now</Button>
			</div>
		{/each}
		{#each model.cards as card (card.key)}
			{@render projectCard(card)}
		{/each}
		{#if model.quiet.length > 0}
			{@const closed = model.quiet.flatMap((c) => c.places.filter((p) => p.machine.local).flatMap((p) => p.dead))}
			<section class="card quiet">
				<span class="lbl">
					no session
					{#if closed.length > 0}
						<button type="button" class="sweep" title="Forget the closed sessions in these projects" onclick={() => sweepDead(fleetStore.machines[0], closed)}>
							clear {closed.length} closed
						</button>
					{/if}
				</span>
				{#each model.quiet as card (card.key)}
					{@const dead = card.places.reduce((n, p) => n + p.dead.length, 0)}
					<!-- A chip opens its menu: new session with any agent (on each machine
					     that holds it), clear what closed, or take the project off the list.
					     One tap on a phone and a click on a desktop do the same, with nothing
					     hidden behind hover. -->
					<Popover.Root open={quietMenu === card.key} onOpenChange={(o) => (quietMenu = o ? card.key : null)}>
						<Popover.Trigger class="q" title={card.where}>
							{@render tile(card)}{card.name}
							{#if dead > 0}<span class="qdead" title="{dead} closed session{dead === 1 ? '' : 's'}">·{dead}</span>{/if}
						</Popover.Trigger>
						<Popover.Content class="menu qmenu" align="start" sideOffset={6}>
							<div class="qhead">
								<b>{card.name}</b>
								{#each card.places as place (place.key)}
									<span class="qpath">{place.root}{#if card.spans || !place.machine.local} · {place.machine.server.hostname}{/if}</span>
								{/each}
							</div>
							{#each card.reachable as place (place.key)}
								{#each AGENT_IDS as id (id)}
									{@const meta = AGENTS[id]}
									<button type="button" class="mitem" onclick={() => { quietMenu = null; void newSessionInProject(place.machine, place.root, id); }}>
										<iconify-icon icon={meta.icon} style="color: {meta.color};"></iconify-icon>New {meta.label} session{#if card.spans} on {place.machine.server.hostname}{/if}
									</button>
								{/each}
							{/each}
							<span class="msep"></span>
							{#each card.places.filter((p) => p.machine.local && p.dead.length > 0) as place (place.root)}
								<button type="button" class="mitem" onclick={() => { quietMenu = null; sweepDead(place.machine, place.dead); }}>
									<iconify-icon icon="mdi:broom"></iconify-icon>Clear {place.dead.length} closed session{place.dead.length === 1 ? '' : 's'}
								</button>
							{/each}
							<button type="button" class="mitem" onclick={() => { quietMenu = null; void navigator.clipboard?.writeText(card.places[0].root); }}>
								<iconify-icon icon="mdi:content-copy"></iconify-icon>Copy path
							</button>
							<button type="button" class="mitem danger" onclick={() => { quietMenu = null; closeProject(card); }}>
								<iconify-icon icon="mdi:close"></iconify-icon>Remove from list
							</button>
						</Popover.Content>
					</Popover.Root>
				{/each}
			</section>
		{/if}
		{#if model.loose.length > 0}
			<section class="card proj loose">
				<div class="proj-h">
					<span class="chip dim">~</span>
					<span class="pname">outside any project</span>
					<span class="pcount">{model.loose.reduce((n, l) => n + l.rows.filter((r) => !r.orchestrator).length + l.panes.length, 0)}</span>
				</div>
				{#each model.loose as place (place.key)}
					{@render placeRows(place, model.loose.length > 1 || (fleetStore.selected === 'all' && fleetStore.fleet))}
				{/each}
			</section>
		{/if}
	</div>
</div>

<FolderPicker
	bind:this={folderPicker}
	bind:open={showFolderBrowser}
	onpick={(cwd) => void newSessionInProject(pickerMachine ?? fleetStore.machines[0], cwd)}
/>

<Dialog.Root open={agentPicker !== null} onOpenChange={(o) => { if (!o) agentPicker = null; }}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>New session</Dialog.Title>
			<Dialog.Description>
				{#if agentPicker}In {agentPicker.cwd}{#if !agentPicker.machine.local} on {agentPicker.machine.server.hostname}{/if}.{/if}
				Choose which agent to launch.
			</Dialog.Description>
		</Dialog.Header>
		<div class="agent-choices">
			{#each AGENT_IDS as id (id)}
				{@const meta = AGENTS[id]}
				<button class="agent-choice" onclick={() => pickAgent(id)}>
					<iconify-icon icon={meta.icon} style="color: {meta.color};"></iconify-icon>
					<div class="agent-choice-text">
						<div class="agent-choice-name">{meta.label}</div>
						<div class="agent-choice-cmd">{meta.command}</div>
					</div>
				</button>
			{/each}
		</div>
		{#if agentPicker?.card}
			<button type="button" class="agent-remove" onclick={removeFromPicker}>
				<iconify-icon icon="mdi:close"></iconify-icon>
				Remove {agentPicker.card.name} from the list
			</button>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<RenameSessionDialog sessionId={renameId} onClose={() => (renameId = null)} />

<AlertDialog.Root bind:open={alertOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{alertTitle}</AlertDialog.Title>
			<AlertDialog.Description>{alertMessage}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => { alertOnConfirm(); alertOpen = false; }} class="bg-destructive text-destructive-foreground hover:bg-destructive/90">Confirm</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	/* The composer's surface, borrowed: one panel, cards on it. */
	.panel {
		--surface: #151516;
		--surface-2: #1b1b1d;
		--surface-3: #212124;
		--line: #2a2a2c;
		--line-soft: #1f1f21;
		--text: #e7e5e4;
		--muted: #a8a29e;
		--dim: #6b6764;
		--faint: #3a3836;
		--amber: #f59e0b;
		--amber-soft: #3a2d0d;
		--green: #34d399;
		--green-deep: #15803d;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 10px 4px;
		font-size: 13px;
		color: var(--text);
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 14px;
	}

	/* ── header ─────────────────────────────────────────────── */
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 7px 7px 8px;
	}
	.head :global(.machine-filter-trigger) {
		flex: 1;
	}
	.panel :global(.ghost) {
		width: 30px;
		height: 30px;
		flex: none;
		display: inline-grid;
		place-items: center;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--muted);
		font-size: 17px;
		cursor: pointer;
	}
	.panel :global(.ghost:hover),
	.panel :global(.ghost.lit) {
		background: var(--surface-3);
		color: var(--text);
	}
	.new {
		height: 30px;
		flex: none;
		padding: 0 11px 0 8px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 0;
		border-radius: 9px;
		background: var(--green-deep);
		color: #ecfdf5;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.new:hover {
		background: #166534;
	}
	.new iconify-icon {
		font-size: 16px;
	}
	:global(.menu) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 200px;
		padding: 6px;
		background: #151516;
		border: 1px solid #2a2a2c;
		border-radius: 12px;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 9px;
		height: 32px;
		padding: 0 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: #d6d3d1;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.mitem:hover {
		background: #212124;
		color: #f5f5f4;
	}
	.mitem.danger {
		color: #fca5a5;
	}
	.mitem iconify-icon {
		font-size: 16px;
		color: #a8a29e;
	}
	.search {
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		outline: none;
	}
	.search:focus {
		border-color: #3f3f46;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--green);
		flex: none;
	}
	.dot.off {
		background: var(--faint);
	}
	/* ── list and cards ─────────────────────────────────────── */
	.list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	/* A finger needs more room at the foot: the last card sits right above
	   the foot's own buttons. */
	@media (pointer: coarse) {
		.list {
			padding-bottom: 24px;
		}
	}
	/* One machine's share of a project; an offline machine's is inert and dimmed. */
	.place.off {
		opacity: 0.45;
		filter: grayscale(0.6);
	}
	/* Which machine, when a project spans several. */
	.pmachine {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 7px 1px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--dim);
	}
	.offline {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 4px;
		font-size: 11.5px;
		color: var(--muted);
	}
	.offline iconify-icon {
		font-size: 14px;
		color: var(--dim);
	}
	.offline .why {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.offline .next {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--dim);
		white-space: nowrap;
	}
	.offline :global(.try) {
		margin-left: auto;
	}
	.empty {
		padding: 18px 10px;
		color: var(--dim);
		font-size: 12.5px;
		text-align: center;
	}
	.link {
		border: 0;
		background: none;
		color: var(--muted);
		text-decoration: underline dotted;
		font: inherit;
		cursor: pointer;
	}
	.proj {
		padding: 5px 5px 5px;
	}
	.proj.wants {
		border-color: #5a4310;
		box-shadow: inset 0 0 0 1px var(--amber-soft);
	}
	.proj.loose {
		border-style: dashed;
	}
	.proj.loose .pname {
		color: var(--dim);
		font-weight: 500;
	}
	.proj-h {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 5px 3px 6px;
	}
	.chip {
		width: 18px;
		height: 18px;
		flex: none;
		border-radius: 6px;
		display: inline-grid;
		place-items: center;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: #0b0b0c;
	}
	.chip.dim {
		background: var(--surface-3);
		color: var(--dim);
	}
	/* The chip, name and count fold the card: shut, only the heading stays,
	   amber when a session in it wants a person. */
	.pfold {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.pfold:hover .pname {
		color: var(--muted);
	}
	.pchev {
		font-size: 14px;
		color: var(--faint);
	}
	.proj.pfolded.wants .pname,
	.proj.pfolded.wants .pchev {
		color: var(--amber);
	}
	.pname {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		letter-spacing: 0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pcount {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
	}
	.pbtn {
		width: 24px;
		height: 24px;
		flex: none;
		display: inline-grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--dim);
		font-size: 15px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms;
	}
	.proj:hover .pbtn,
	.proj:focus-within .pbtn {
		opacity: 1;
	}
	.pbtn:hover {
		background: var(--surface-3);
		color: var(--text);
	}
	.pclose:hover {
		color: #fca5a5;
	}
	@media (hover: none) {
		/* Always shown, and the 24px glyph takes a finger-sized tap. */
		.pbtn {
			opacity: 1;
			width: 44px;
			height: 44px;
			margin: -10px -10px -10px -14px;
		}
		.pclose {
			display: none;
		}
	}

	/* ── threads: what a session spawned hangs under it ── */
	.thread {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-left: 13px;
		padding-left: 10px;
	}
	.thread.worker {
		border-left: 2px solid #4c3a8a;
	}
	/* Workers side by side share one unbroken thread. */
	.thread.worker + .thread.worker {
		margin-top: -2px;
		padding-top: 2px;
	}
	.thread.agents {
		gap: 0;
		border-left: 2px dashed #155e63;
		margin-top: 2px;
	}
	.thread.worker .thread.agents {
		margin-left: 9px;
	}

	/* ── tmux pane row (session rows draw themselves: SessionRow) ── */
	.row {
		display: grid;
		grid-template-columns: 16px 1fr auto 14px;
		column-gap: 8px;
		align-items: center;
		padding: 5px 7px;
		border-radius: 9px;
		color: var(--text);
		text-decoration: none;
		position: relative;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.cur {
		background: var(--surface-3);
	}
	.row .st {
		display: grid;
		place-items: center;
		width: 16px;
	}
	.row .st iconify-icon {
		font-size: 13px;
		color: var(--dim);
	}
	.row .name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .name.mono {
		font-family: var(--font-mono);
		color: var(--muted);
		font-size: 12px;
	}
	.row .meta {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.row .when {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
		white-space: nowrap;
	}
	.ctx {
		width: 14px;
		height: 14px;
	}

	/* closed sessions, folded */
	.dead {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 7px 2px;
		font-size: 11.5px;
		color: var(--dim);
	}
	.dead .n {
		font-family: var(--font-mono);
	}
	.sweep {
		margin-left: auto;
		border: 0;
		background: none;
		color: var(--dim);
		font: inherit;
		text-decoration: underline dotted;
		cursor: pointer;
	}
	.sweep:hover {
		color: var(--muted);
	}

	/* projects with nothing running */
	.quiet {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 8px;
	}
	.qdead {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--dim);
	}
	.quiet .lbl {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 0 2px 1px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--dim);
	}
	/* A quiet chip is the trigger of its own menu. */
	:global(.q) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 8px 0 6px;
		border-radius: 8px;
		background: var(--surface-2);
		border: 1px solid var(--line-soft);
		color: var(--muted);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	:global(.q:hover),
	:global(.q[data-state='open']) {
		color: var(--text);
		border-color: var(--line);
	}
	/* The project's tile: its icon, or its initials on its own hue. */
	.panel :global(.ptile) {
		width: 20px;
		height: 20px;
		border-radius: 6px;
	}
	.panel :global(.ptile::after) {
		border-radius: 6px;
		border-color: hsl(var(--h) 50% 34%);
	}
	.panel :global(.ptile-img) {
		border-radius: 6px;
		object-fit: contain;
		background: var(--surface-2);
		padding: 2px;
	}
	.panel :global(.ptile-init) {
		border-radius: 6px;
		background: hsl(var(--h) 45% 22%);
		color: hsl(var(--h) 85% 82%);
		font: 650 9px/1 var(--font-sans, system-ui);
		letter-spacing: 0.02em;
	}
	.panel :global(.q .ptile) {
		width: 16px;
		height: 16px;
		border-radius: 5px;
	}
	.panel :global(.q .ptile-init) {
		font-size: 7.5px;
	}
	/* A phone has no pixel-perfect finger, and these chips are the only way to
	   start a session in a project that has none, so on touch they grow into a
	   real tap target. */
	@media (hover: none) {
		:global(.q) {
			height: 40px;
			padding: 0 12px 0 10px;
		}
	}
	:global(.menu.qmenu) {
		width: 250px;
	}
	.qhead {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px 10px 6px;
		min-width: 0;
	}
	.qhead b {
		font-size: 13px;
		color: #f5f5f4;
	}
	.qpath {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: #a8a29e;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.msep {
		height: 1px;
		margin: 3px 4px;
		background: #2a2a2c;
	}

	/* agent picker */
	.agent-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		min-height: 40px;
		margin-top: 4px;
		border: 1px solid #2a2a2c;
		border-radius: 10px;
		background: transparent;
		color: #fca5a5;
		font-size: 13px;
		cursor: pointer;
	}
	.agent-remove:hover {
		background: #2a1515;
	}
	.agent-choices {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.agent-choice {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid #2a2a2c;
		border-radius: 10px;
		background: #151516;
		color: #e7e5e4;
		text-align: left;
		cursor: pointer;
	}
	.agent-choice:hover {
		background: #212124;
	}
	.agent-choice iconify-icon {
		font-size: 22px;
	}
	.agent-choice-name {
		font-weight: 500;
	}
	.agent-choice-cmd {
		font-family: var(--font-mono);
		font-size: 11px;
		color: #6b6764;
	}
</style>
