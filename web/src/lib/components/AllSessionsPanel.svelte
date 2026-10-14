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
	import {
		apiBase,
		blockedReason,
		fleetStore,
		isSettled,
		liveCount,
		machineKey,
		offlineReason,
		reachable,
		selfName,
		setSettled,
		type Machine
	} from '$lib/stores/fleet.svelte';
	import { localRef, parseSessionPath, pastPath, sessionPath } from '$lib/session-route';
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
	import * as ContextMenu from '$lib/components/ui/context-menu';
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
	import { RAIL_ORDER } from '$shared/fleet-prefs.js';
	import { pastByRoot, pastLabel, SETTLED_SHOWN, type PastSession } from '$shared/past-session.js';
	import { resumePast } from '$lib/past-resume';
	import { formatAgo } from '$lib/format';
	import { guessReport, isHomeDir, mergeProjects, projectHue, projectInitials } from '$shared/fleet-projects.js';
	import { machineMarks, matchesQuery, moveTile, railOrder, type MachineMark } from '$shared/fleet-rail.js';
	import { indicatorStateOf } from '$shared/session-state.js';
	import ProjectTile from './ProjectTile.svelte';
	import ProjectRail, { type RailTile } from './ProjectRail.svelte';
	import QuickSwitch, { type SwitchItem } from './QuickSwitch.svelte';
	import { quickSwitch } from '$lib/stores/quick-switch.svelte';
	import { drawer } from '$lib/stores/drawer.svelte';

	/** The root of a project made of the sessions that have not said where they run. */
	const NO_FOLDER = '';
	import { sidebarActionsStore, type ChordAction } from '$lib/stores/sidebarActions.svelte';
	import { splitStore } from '$lib/stores/split.svelte';
	import { formatRef, type PaneRef } from '$lib/split-refs';

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
	let query = $state('');
	/** The project whose menu is open, by key; null when none is. */
	let projectMenu = $state<string | null>(null);

	/**
	 * What the list beside the rail shows: 'active' (everything wanting a
	 * person, working or just finished), or one project by key. A page lands
	 * on Active.
	 */
	let selected = $state<string>('active');

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

	function pickAgent(agent: SessionAgent) {
		const target = agentPicker;
		agentPicker = null;
		if (target) void newSessionInProject(target.machine, target.cwd, agent);
	}

	function removeFromPicker() {
		const target = agentPicker;
		agentPicker = null;
		// Only where the dialog was opened: the project stays on its other machines.
		if (target?.card) {
			closeProject(target.card, target.card.places.filter((p) => p.machine === target.machine && p.root === target.cwd));
		}
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
		/** How it is told from the project's other places: its machine, and its folder when that machine holds two. */
		label: string;
		rows: Row[];
		/** Its live sessions, from which Active picks its own rows. */
		live: Session[];
		dead: Session[];
		panes: TmuxPane[];
		/** Live sessions settled by hand, drawn in Settled instead. */
		settled: Session[];
		/** Its past sessions, newest first. */
		past: PastSession[];
	}

	/** One project (`src/fleet-projects.ts`): the same codebase on every machine that holds it. */
	interface Card {
		key: string;
		name: string;
		initials: string;
		hue: number;
		/** Its icon's URL, through the relay when another machine holds it; null draws the initials. */
		icon: string | null;
		/** Amber when a session in it wants a person, green when one works or just finished. */
		badge: 'wants' | 'working' | null;
		/** Nothing running there, closed sessions included. */
		quiet: boolean;
		/** The visible machines that hold it, in the fleet's order. */
		places: Place[];
		/** The places whose machine answers, where a session can start. */
		reachable: Place[];
		/** Whether it is held in more than one place, so each place says which. */
		spans: boolean;
		/** Its live sessions, orchestrators not counted. */
		live: number;
		/** Each machine and root that holds it, one per line, for a tooltip. */
		where: string;
		/** Its past sessions from every place it is held, newest first. */
		past: { place: Place; past: PastSession }[];
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
	 * that started this tick), reduced so no root sits under another. A
	 * session in a directory that is nobody's project (`~`, `/tmp`) makes
	 * that directory a project of its own on that machine, last, so it never
	 * takes in the folders below it.
	 */
	function rootsOf(machine: Machine): string[] {
		const roots = [...machine.projects];
		// Only a Claude session makes a folder a project; a plain shell joins one that is.
		const cwds = machine.sessions.map((s) => s.cwd).filter((cwd): cwd is string => !!cwd);
		const extra = cwds.filter((cwd) => !looksLikeRoot(cwd)).sort((a, b) => a.length - b.length);
		for (const cwd of extra) {
			if (roots.some((r) => under(cwd, r))) continue;
			roots.push(cwd);
		}
		for (const cwd of new Set(cwds.filter(looksLikeRoot))) {
			if (!roots.includes(cwd) && !roots.some((r) => under(cwd, r))) roots.push(cwd);
		}
		// A session that has not said where it runs still has to be somewhere.
		if (machine.sessions.some((s) => !s.cwd)) roots.push(NO_FOLDER);
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

	function rowsFor(sessions: Session[], root: string): Row[] {
		const rows: Row[] = [];
		for (const item of groupSessions(sessions)) {
			if (item.type === 'pair') {
				rows.push({ session: item.main, rel: relPath(item.main.cwd, root), orchestrator: false });
				rows.push({ session: item.orchestrator, rel: null, orchestrator: true });
			} else {
				rows.push({ session: item.session, rel: relPath(item.session.cwd, root), orchestrator: false });
			}
		}
		return nestWorkers(rows);
	}

	/** What a session asks of the eye: a person (amber), or a look at its work (green), or nothing. */
	function attention(s: Session): 'wants' | 'working' | null {
		if (wantsHuman(s)) return 'wants';
		return s.state === 'busy' || indicatorStateOf(s) === 'done' ? 'working' : null;
	}

	/** Whether a session is one Active shows: it wants a person, works, just finished, or is open. */
	function isActive(machine: Machine, s: Session): boolean {
		return attention(s) !== null || isCurrent(machine, s.tmux_target);
	}

	/** A machine's sessions and panes, put under its project roots (`rootsOf()`). */
	function placesOf(machine: Machine, roots: string[]): Map<string, Place> {
		const claudeTargets = new Set(machine.sessions.map((s) => s.tmux_target));
		// tmux panes are read from this host only.
		const panes = machine.local ? tmuxPanes.filter((p) => !claudeTargets.has(p.target)) : [];

		const byRoot = new Map<string, { live: Session[]; dead: Session[]; panes: TmuxPane[]; settled: Session[] }>();
		for (const root of roots) byRoot.set(root, { live: [], dead: [], panes: [], settled: [] });
		for (const s of machine.sessions) {
			const root = s.cwd ? findDeepestProject(s.cwd, roots) : NO_FOLDER;
			if (root === null) continue;
			const bucket = byRoot.get(root)!;
			(s.pane_alive === false ? bucket.dead : isSettled(machine, s.id) ? bucket.settled : bucket.live).push(s);
		}
		const past = pastByRoot(machine.past, roots, new Set(machine.sessions.filter((s) => s.pane_alive !== false).map((s) => s.id)));
		for (const pane of panes) {
			const root = pane.cwd ? findDeepestProject(pane.cwd, roots) : null;
			if (root) byRoot.get(root)!.panes.push(pane);
		}

		const places = new Map<string, Place>();
		for (const [root, bucket] of byRoot) {
			places.set(root, {
				key: placeKey(machine, root),
				machine,
				root,
				label: machineLabel(machine),
				rows: rowsFor(bucket.live, root),
				live: bucket.live,
				dead: bucket.dead,
				panes: bucket.panes,
				settled: bucket.settled,
				past: past.get(root) ?? []
			});
		}
		return places;
	}

	/** A machine's name, as a place under a project says it. */
	function machineLabel(machine: Machine): string {
		return machine.server.hostname || 'this machine';
	}

	function placeKey(machine: Machine, root: string): string {
		return `${machineKey(machine)}\0${root}`;
	}

	// ── Settled ──────────────────────────────────────────────────────────────

	/**
	 * Settle a live session: it moves to Settled on every link, and its machine
	 * ends it when Claude Code sits idle at its prompt (`settleCloses()`);
	 * anything else keeps running there.
	 */
	function settle(machine: Machine, id: string) {
		setSettled(machine, id, true);
		void fetch(`${apiBase(machine)}/api/sessions/${encodeURIComponent(id)}/settle`, { method: 'POST' }).catch(() => {});
	}

	/** Which projects' Settled sections are open; each starts folded. */
	let settledOpen = $state<Set<string>>(new Set());
	/** Which projects show every past session rather than the first ten. */
	let settledAll = $state<Set<string>>(new Set());
	function toggleIn(set: Set<string>, key: string): Set<string> {
		const next = new Set(set);
		if (!next.delete(key)) next.add(key);
		return next;
	}

	/** The live session being dragged, so a drop on Settled or back on the list knows which. */
	let dragged = $state<{ machine: Machine; session: Session } | null>(null);
	/** Where a dragged row would land: a project's Settled header, or its live list. */
	let dropOn = $state<'settled' | 'live' | null>(null);

	/** Whether the dragged row can land there: a live one on Settled, a settled one back on the list. */
	function canDrop(to: 'settled' | 'live'): boolean {
		return !!dragged && isSettled(dragged.machine, dragged.session.id) === (to === 'live');
	}
	function dragOver(e: DragEvent, to: 'settled' | 'live') {
		if (!canDrop(to)) return;
		e.preventDefault();
		dropOn = to;
	}
	function drop(e: DragEvent, to: 'settled' | 'live') {
		const d = dragged;
		const ok = canDrop(to);
		dropOn = null;
		if (!d || !ok) return;
		e.preventDefault();
		if (to === 'settled') settle(d.machine, d.session.id);
		else setSettled(d.machine, d.session.id, false);
	}

	function pastHref(machine: Machine, p: PastSession): string {
		return pastPath(machine.local ? null : machine.server.hostname, p.id);
	}

	/** Open a past session's page, where its transcript is read before anything restarts. */
	function openPast(machine: Machine, p: PastSession) {
		goto(pastHref(machine, p));
		onSessionSelect?.();
	}

	/**
	 * Resume a past session from its row's menu: on its own machine, in its
	 * folder, or in the project's root when that folder is gone and the person
	 * agrees. A session running already is opened instead.
	 */
	async function resume(machine: Machine, p: PastSession, cwd?: string) {
		const result = await resumePast(machine, apiBase(machine), p.id, cwd);
		if (result.kind === 'offer-root') {
			const root = result.root;
			showConfirm('Folder is gone', `${result.cwd} no longer exists. Resume “${pastLabel(p)}” in ${root}?`, () => void resume(machine, p, root));
			return;
		}
		if (result.kind === 'error') {
			alert(result.message);
			return;
		}
		goToSession(machine, result.tmuxTarget);
	}

	/** A project's icon, from the machine that has it. */
	function iconUrl(machine: Machine, root: string, token: string): string {
		return `${apiBase(machine)}/api/projects/icon?root=${encodeURIComponent(root)}&v=${encodeURIComponent(token)}`;
	}

	/**
	 * Every project in the fleet, matched across machines, with the sessions
	 * the visible machines run in it, in the rail's order. Names and icons
	 * come from the whole fleet, so filtering to one machine does not change
	 * how a project looks.
	 */
	const cards = $derived.by((): Card[] => {
		const visible = new Set(fleetStore.visible.map(machineKey));
		const roots = new Map(fleetStore.machines.map((machine) => [machineKey(machine), rootsOf(machine)]));
		// Rows are laid out only for the machines shown; the rest lend the merge their roots alone.
		const byKey = new Map(
			fleetStore.visible.map((machine) => [machineKey(machine), placesOf(machine, roots.get(machineKey(machine))!)])
		);
		const projects = mergeProjects(
			fleetStore.machines.map((machine) => {
				const known = new Map(machine.projectReports.map((r) => [r.root, r]));
				const id = machineKey(machine);
				return { id, reports: roots.get(id)!.map((root) => known.get(root) ?? guessReport(root)) };
			})
		);

		const out: Card[] = [];
		for (const project of projects) {
			const shown = project.places
				.filter((p) => visible.has(p.machineId))
				.map((p) => byKey.get(p.machineId)!.get(p.root)!);
			if (shown.length === 0) continue;
			// Two checkouts of one repo on one machine are told apart by their folders.
			const places = shown.map((p) =>
				shown.some((o) => o !== p && o.machine === p.machine) ? { ...p, label: `${p.label} · ${p.root.split('/').pop()}` } : p
			);
			const icon = project.icon;
			const iconAt = icon && fleetStore.machines.find((m) => machineKey(m) === icon.machineId);
			const home = places.length === 1 && isHomeDir(places[0].root);
			const name = home ? '~' : places.every((p) => p.root === NO_FOLDER) ? 'no folder' : project.name;
			// An offline machine's dialogs may long be answered: they badge nothing.
			// A settled session still running can come to want a person; its tile says so.
			const seen = places
				.filter((p) => p.machine.online)
				.flatMap((p) => [...p.rows.map((r) => attention(r.session)), ...p.settled.filter(wantsHuman).map(() => 'wants' as const)]);
			out.push({
				key: project.key,
				name,
				initials: home ? '~' : projectInitials(name),
				hue: projectHue(name),
				icon: icon && iconAt ? iconUrl(iconAt, icon.root, icon.token) : null,
				badge: seen.includes('wants') ? 'wants' : seen.includes('working') ? 'working' : null,
				quiet: places.every((p) => p.rows.length === 0 && p.panes.length === 0),
				places,
				reachable: places.filter((p) => reachable(p.machine)),
				spans: new Set(places.map((p) => p.machine)).size > 1,
				live: places.reduce((n, p) => n + p.rows.filter((r) => !r.orchestrator).length, 0),
				where: places.map((p) => `${p.machine.server.hostname}:${p.root}`).join('\n'),
				past: places
					.flatMap((place) => place.past.map((past) => ({ place, past })))
					.sort((a, b) => b.past.lastActivity - a.past.lastActivity)
			});
		}
		// The rail is in the person's order (`railOrder()`): a project it has
		// never seen goes on top, by name among themselves, and nothing moves
		// because of what runs in it.
		out.sort((a, b) => a.name.localeCompare(b.name));
		const byProject = new Map(out.map((c) => [c.key, c]));
		return railOrder(fleetPrefsStore.get<unknown>(RAIL_ORDER, null), out.map((c) => c.key)).map((k) => byProject.get(k)!);
	});

	/** Drop a tile: the new order is saved for the whole fleet. */
	function moveProject(key: string, before: string | null) {
		// Placed among the tiles drawn, which the filter may have narrowed.
		const next = moveTile(fleetPrefsStore.get<unknown>(RAIL_ORDER, null), tiles.map((t) => t.key), key, before);
		void fleetPrefsStore.set(RAIL_ORDER, next);
	}

	/** Show a project (or 'active') in the list, leaving the filter. */
	function openProject(key: string) {
		query = '';
		selected = key;
	}

	/** The project the list shows; null on Active, or when the one chosen is gone. */
	const chosen = $derived(selected === 'active' ? null : (cards.find((c) => c.key === selected) ?? null));

	/** Each machine's letter and colour, the same on every link. */
	const marks = $derived(machineMarks(fleetStore.machines.map((m) => ({ id: machineKey(m), name: machineLabel(m) }))));
	function markOf(machine: Machine): MachineMark {
		return marks.get(machineKey(machine)) ?? { letter: '?', color: '#a8a29e', name: machineLabel(machine) };
	}

	/** What the filter looks at in a session: its name, folder, machine and issue. */
	function rowMatches(machine: Machine, row: Row): boolean {
		const s = row.session;
		return matchesQuery(query, [rowTitle(row), getSessionDisplayName(s), s.cwd, machine.server.hostname, s.maestro_issue, s.issue?.title]);
	}

	/**
	 * What the filter finds, by project in the rail's order: a project found by
	 * its name or one of its machines with all its sessions, else the sessions
	 * found in it.
	 */
	const found = $derived.by(() => {
		if (!query.trim()) return [];
		const out: { card: Card; places: Place[] }[] = [];
		for (const card of cards) {
			const whole = matchesQuery(query, [card.name, ...card.places.map((p) => p.root)]);
			const places = card.places
				.map((p) =>
					whole || matchesQuery(query, [p.machine.server.hostname]) ? p : { ...p, rows: p.rows.filter((r) => rowMatches(p.machine, r)), panes: [], dead: [] }
				)
				.filter((p) => whole || p.rows.length > 0 || p.panes.length > 0);
			if (places.length > 0) out.push({ card, places });
		}
		return out;
	});

	/**
	 * Active: by project, the sessions wanting a person, working, just
	 * finished or open. Laid out only while Active is shown, and apart from
	 * `cards`, so opening a session does not rebuild every project.
	 */
	const activeGroups = $derived(
		cards
			.map((card) => ({
				card,
				places: card.places
					.map((p) => ({ ...p, rows: rowsFor(p.live.filter((s) => isActive(p.machine, s)), p.root) }))
					.filter((p) => p.rows.length > 0)
			}))
			.filter((g) => g.places.length > 0)
	);
	const activeBadge = $derived(
		cards.some((c) => c.badge === 'wants') ? 'wants' : cards.some((c) => c.badge === 'working') ? 'working' : null
	);

	const tiles: RailTile[] = $derived(query.trim() ? found.map((f) => f.card) : cards);

	/** The visible machines that are off, each said once above the list. */
	const offlineMachines = $derived(fleetStore.visible.filter((m) => offlineReason(m, clock.now)));
	/** Machines that answer but run a claude-mux too old for this one: the relay refuses them. */
	const tooOldMachines = $derived(
		fleetStore.visible.filter((m) => !offlineReason(m, clock.now) && blockedReason(m, clock.now))
	);

	/** Ctrl+K reaches every session and project on the machines the drawer shows. */
	const switchItems = $derived.by((): SwitchItem[] => {
		const items: SwitchItem[] = [];
		for (const card of cards) {
			for (const place of card.places) {
				for (const row of place.rows) {
					const s = row.session;
					if (row.orchestrator || !s.tmux_target) continue;
					const target = s.tmux_target;
					items.push({
						id: `s:${place.key}:${s.id}`,
						kind: 'session',
						title: rowTitle(row),
						detail: card.name,
						fields: [getSessionDisplayName(s), card.name, s.cwd, place.machine.server.hostname, s.maestro_issue],
						machine: fleetStore.fleet ? markOf(place.machine) : null,
						state: indicatorStateOf(s),
						off: !reachable(place.machine),
						run: () => openSession(place.machine, target)
					});
				}
			}
		}
		for (const card of cards) {
			items.push({
				id: `p:${card.key}`,
				kind: 'project',
				title: card.name,
				detail: [...new Set(card.places.map((p) => p.machine.server.hostname))].join(', '),
				fields: [...card.places.map((p) => p.root), ...card.places.map((p) => p.machine.server.hostname)],
				tile: { initials: card.initials, hue: card.hue, icon: card.icon },
				run: () => {
					openProject(card.key);
					// On a phone the list is in the drawer, which may be shut.
					if (window.matchMedia('(max-width: 768px)').matches) drawer.open = true;
				}
			});
		}
		for (const card of cards) {
			for (const { place, past } of card.past) {
				items.push({
					id: `past:${place.key}:${past.id}`,
					kind: 'past',
					title: pastLabel(past),
					// A getter, so only the rows drawn read the clock, not the whole list each second.
					get detail() {
						return `${card.name} · ${formatAgo(past.lastActivity, clock.now)}`;
					},
					fields: [past.prompt, past.title, past.cwd, past.branch, card.name, place.machine.server.hostname],
					machine: fleetStore.fleet ? markOf(place.machine) : null,
					off: !reachable(place.machine),
					run: () => openPast(place.machine, past)
				});
			}
		}
		// Sessions wanting a person first, then those working, then the rest as the
		// rail has them; past sessions after everything live.
		const rank = (it: SwitchItem) =>
			it.kind === 'past' ? 4 : it.kind === 'project' ? 3 : it.state === 'waiting' || it.state === 'permission' ? 0 : it.state === 'busy' || it.state === 'done' ? 1 : 2;
		return items.sort((a, b) => rank(a) - rank(b));
	});

	/** Ctrl+K anywhere on the page opens the switcher. */
	function onKey(e: KeyboardEvent) {
		if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
		e.preventDefault();
		quickSwitch.open = true;
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

	/**
	 * Close a project in the given places (every place the list shows, by
	 * default): its sessions killed, its folder taken off each machine's list.
	 * An offline machine cannot be asked, so its place is left as it is.
	 */
	function closeProject(card: Card, among: Place[] = card.places) {
		const places = among.filter((p) => reachable(p.machine));
		if (places.length === 0) return;
		const live = places.reduce((n, p) => n + p.rows.filter((r) => !r.orchestrator).length, 0);
		const where = card.spans ? ` on ${places.map((p) => p.label).join(', ')}` : '';
		const msg =
			live > 0
				? `Kill ${live} session${live === 1 ? '' : 's'} in ${card.name}${where} and remove the project?`
				: `Remove ${card.name}${where} from the list? Its sessions are gone; the folder stays.`;
		showConfirm('Close project', msg, async () => {
			await Promise.all(
				places.map(async ({ machine, root, rows, dead }) => {
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

{#snippet sessionRow(machine: Machine, row: Row, marked: boolean, offline: string | null)}
	{#if row.worker}
		<!-- A worker hangs off its master on a solid violet thread, and its own
		     subagents ride inside that thread. -->
		<div class="thread worker">{@render rowWithAgents(machine, row, marked, offline)}</div>
		<!-- A master's own subagents come after its workers, as in the design. -->
		{#if row.trailing}{@render agentThread(machine, row.trailing, agentsOf(row.trailing))}{/if}
	{:else}
		{@render rowWithAgents(machine, row, marked, offline)}
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

{#snippet rowWithAgents(machine: Machine, row: Row, marked: boolean, offline: string | null)}
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
		ondragstart={(e) => {
			dragged = { machine, session: s };
			if (s.tmux_target) dragStart(e, machine, s.tmux_target);
		}}
		ondragend={() => {
			dragged = null;
			dropOn = null;
			dragEnd();
		}}
		menu={[
			...(s.tmux_target && !splitStore.active ? panelMenu(machine, s.tmux_target) : []),
			isSettled(machine, s.id)
				? { label: 'Un-settle', icon: 'mdi:tray-arrow-up', run: () => setSettled(machine, s.id, false) }
				: { label: 'Settle', icon: 'mdi:tray-arrow-down', run: () => settle(machine, s.id) }
		]}
		machine={marked ? markOf(machine) : null}
		{offline}
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

{#snippet placeRows(place: Place, marked: boolean, extras: boolean)}
	{@const offline = blockedReason(place.machine, clock.now)}
	<!-- An offline machine's rows stay, dimmed and out of reach, until it answers
	     again; so do those of one too old for this machine, until it is updated. -->
	<div class="place" class:off={!!offline} inert={!!offline}>
		{#each place.rows as row (row.session.id)}
			{@render sessionRow(place.machine, row, marked, offline)}
		{/each}
		{#if extras}
			{#each place.panes as pane (pane.target)}
				{@render paneRow(place.machine, pane)}
			{/each}
			{#if place.dead.length > 0}
				<div class="dead">
					<span class="n">{place.dead.length}</span>
					{place.dead.length === 1 ? 'closed session' : 'closed sessions'}{#if marked} on {place.label}{/if}
					{#if place.machine.local}
						<button type="button" class="sweep" onclick={() => sweepDead(place.machine, place.dead)}>clear</button>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet groupHead(card: Card)}
	<!-- A project's name over its sessions in Active and in what the filter
	     found; it opens the project. -->
	<button type="button" class="ghead" title={card.where} onclick={() => openProject(card.key)}>
		<ProjectTile initials={card.initials} hue={card.hue} icon={card.icon} size={18} />
		<span class="gname">{card.name}</span>
	</button>
{/snippet}

{#snippet offlineLines(machines: Machine[])}
	{#each machines.filter((m) => tooOldMachines.includes(m)) as machine (machine.server.id || machine.server.hostname)}
		{@const why = blockedReason(machine, clock.now)}
		<div class="offline" role="status">
			<iconify-icon icon="mdi:update"></iconify-icon>
			<span class="why" title={why}>{why}</span>
			<Button variant="outline" size="sm" class="try" href="/machines">Machines</Button>
		</div>
	{/each}
	{#each machines.filter((m) => offlineMachines.includes(m)) as machine (machine.server.hostname)}
		<div class="offline" role="status">
			<iconify-icon icon="mdi:lan-disconnect"></iconify-icon>
			<span class="why">{offlineReason(machine, clock.now)}</span>
			{#if machine.retryAt && machine.retryAt > clock.now}
				<span class="next">retry in {Math.ceil((machine.retryAt - clock.now) / 1000)}s</span>
			{/if}
			<Button variant="outline" size="sm" class="try" onclick={() => void fleetStore.retry(machine)}>Try now</Button>
		</div>
	{/each}
{/snippet}

{#snippet newSessions(card: Card)}
	<!-- One button per machine that holds the folder; a machine that does not
	     answer says so instead. Right-click or hold for another agent. -->
	<div class="newrow">
		{#each card.places.filter((p) => p.root !== NO_FOLDER) as place (place.key)}
			{@const off = blockedReason(place.machine, clock.now)}
			<button
				type="button"
				class="newbtn"
				disabled={!!off}
				title={off ?? `${place.root} · right-click or hold for another agent`}
				onclick={() => void newSessionInProject(place.machine, place.root)}
				oncontextmenu={(e) => { e.preventDefault(); agentPicker = { machine: place.machine, cwd: place.root, card }; }}
				use:longPress={{ onTrigger: () => (agentPicker = { machine: place.machine, cwd: place.root, card }) }}
			>
				<iconify-icon icon="mdi:plus"></iconify-icon>
				New session
				{#if card.places.length > 1}
					<span class="on">on</span>
					{#if card.spans}{@const m = markOf(place.machine)}<span class="mach" style="--m:{m.color}">{m.letter}</span>{/if}
					<span class="where">{place.label}</span>
				{/if}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet projectView(card: Card)}
	{@const closed = card.places.filter((p) => p.machine.local).reduce((n, p) => n + p.dead.length, 0)}
	<div class="rhead">
		<ProjectTile initials={card.initials} hue={card.hue} icon={card.icon} size={30} />
		<div class="rtext">
			<div class="rname" title={card.where}>{card.name}</div>
			<div class="rsub">
				{[card.live > 0 ? `${card.live} session${card.live === 1 ? '' : 's'}` : '', [...new Set(card.places.map((p) => machineLabel(p.machine)))].join(', ')].filter(Boolean).join(' · ')}
			</div>
		</div>
		<Popover.Root open={projectMenu === card.key} onOpenChange={(o) => (projectMenu = o ? card.key : null)}>
			<Popover.Trigger class="ghost" title="Project actions">
				<iconify-icon icon="mdi:dots-horizontal"></iconify-icon>
			</Popover.Trigger>
			<Popover.Content class="menu pmenu" align="end" sideOffset={6}>
				<div class="qhead">
					<b>{card.name}</b>
					{#each card.places as place (place.key)}
						<span class="qpath">{place.root}{#if card.spans || !place.machine.local} · {place.machine.server.hostname}{/if}</span>
					{/each}
				</div>
				{#each card.reachable as place (place.key)}
					{#each AGENT_IDS.filter((id) => id !== 'claude') as id (id)}
						{@const meta = AGENTS[id]}
						<button type="button" class="mitem" onclick={() => { projectMenu = null; void newSessionInProject(place.machine, place.root, id); }}>
							<iconify-icon icon={meta.icon} style="color: {meta.color};"></iconify-icon>New {meta.label} session{#if card.places.length > 1} on {place.label}{/if}
						</button>
					{/each}
				{/each}
				<span class="msep"></span>
				{#if closed > 0}
					<button type="button" class="mitem" onclick={() => { projectMenu = null; for (const p of card.places) if (p.machine.local) sweepDead(p.machine, p.dead); }}>
						<iconify-icon icon="mdi:broom"></iconify-icon>Clear {closed} closed session{closed === 1 ? '' : 's'}
					</button>
				{/if}
				<button type="button" class="mitem" onclick={() => { projectMenu = null; void navigator.clipboard?.writeText(card.places[0].root); }}>
					<iconify-icon icon="mdi:content-copy"></iconify-icon>Copy path
				</button>
				<button type="button" class="mitem danger" onclick={() => { projectMenu = null; closeProject(card); }}>
					<iconify-icon icon="mdi:close"></iconify-icon>Close project
				</button>
			</Popover.Content>
		</Popover.Root>
	</div>
	{@render offlineLines([...new Set(card.places.map((p) => p.machine))])}
	<!-- A settled row dragged back here is un-settled. -->
	<div
		class="livezone"
		class:drop={dropOn === 'live'}
		role="list"
		ondragover={(e) => dragOver(e, 'live')}
		ondragleave={() => (dropOn = null)}
		ondrop={(e) => drop(e, 'live')}
	>
		{#each card.places as place (place.key)}
			{@render placeRows(place, card.spans, true)}
		{/each}
		{#if card.quiet}<div class="nothing">Nothing running here.</div>{/if}
	</div>
	{@render newSessions(card)}
	{@render settledSection(card)}
{/snippet}

{#snippet settledSection(card: Card)}
	{@const settledRows = card.places.flatMap((place) => place.settled.map((session) => ({ place, session })))}
	{@const past = card.past}
	{@const open = settledOpen.has(card.key)}
	{@const shown = settledAll.has(card.key) ? past : past.slice(0, SETTLED_SHOWN)}
	{#if settledRows.length + past.length > 0 || dragged}
		<section class="settled" aria-label="Settled">
			<!-- Drop a live row here to settle it. -->
			<button
				type="button"
				class="shead"
				class:drop={dropOn === 'settled'}
				aria-expanded={open}
				ondragover={(e) => dragOver(e, 'settled')}
				ondragleave={() => (dropOn = null)}
				ondrop={(e) => drop(e, 'settled')}
				onclick={() => (settledOpen = toggleIn(settledOpen, card.key))}
			>
				<iconify-icon class="chev" class:open icon="mdi:chevron-right"></iconify-icon>
				Settled
				<span class="n">{settledRows.length + past.length}</span>
				{#if dropOn === 'settled'}<span class="hint">Drop to settle</span>{/if}
			</button>
			{#if open}
				{#each settledRows as { place, session } (session.id)}
					{@const offline = blockedReason(place.machine, clock.now)}
					<div class="place" class:off={!!offline} inert={!!offline}>
						{@render rowWithAgents(place.machine, { session, rel: relPath(session.cwd, place.root), orchestrator: false }, card.spans, offline)}
					</div>
				{/each}
				{#each shown as { place, past: p } (`${place.key}\0${p.id}`)}
					{@const off = !reachable(place.machine)}
					{@const m = markOf(place.machine)}
					<ContextMenu.Root>
						<ContextMenu.Trigger>
							{#snippet child({ props })}
								<a
									{...props}
									href={pastHref(place.machine, p)}
									class="row past"
									class:off
									title={off ? `${pastLabel(p)} · resume when ${machineLabel(place.machine)} is back` : `${pastLabel(p)}${p.branch ? ` · ${p.branch}` : ''}`}
									onclick={(e) => {
										e.preventDefault();
										openPast(place.machine, p);
									}}
								>
									<span class="st"><iconify-icon icon="mdi:history"></iconify-icon></span>
									<span class="name">{pastLabel(p)}</span>
									<span class="meta">
										{#if card.spans || !place.machine.local}<span class="mach" style="--m:{m.color}" title={m.name}>{m.letter}</span>{/if}
										<span class="when">{formatAgo(p.lastActivity, clock.now)}</span>
									</span>
									<span class="ctx none"></span>
									{#if off}<span class="later">resume when it's back</span>{/if}
								</a>
							{/snippet}
						</ContextMenu.Trigger>
						<ContextMenu.Content>
							<ContextMenu.Item onSelect={() => openPast(place.machine, p)}>
								<iconify-icon icon="mdi:text-box-outline"></iconify-icon>Read
							</ContextMenu.Item>
							<ContextMenu.Item disabled={off} onSelect={() => void resume(place.machine, p)}>
								<iconify-icon icon="mdi:play-outline"></iconify-icon>Resume
							</ContextMenu.Item>
						</ContextMenu.Content>
					</ContextMenu.Root>
				{/each}
				{#if past.length > shown.length}
					<button type="button" class="more" onclick={() => (settledAll = toggleIn(settledAll, card.key))}>
						{past.length - shown.length} more
					</button>
				{/if}
			{/if}
		</section>
	{/if}
{/snippet}

<svelte:window onkeydown={onKey} />

<div class="panel" class:compact>
	<header class="head">
		<MachineFilter live={liveCount} wants={machineWants} />
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
		<button type="button" class="new" title="Open a folder as a project" onclick={newProject}>
			<iconify-icon icon="mdi:plus"></iconify-icon>New
		</button>
	</header>
	<label class="search">
		<iconify-icon icon="mdi:magnify"></iconify-icon>
		<input
			bind:value={query}
			type="search"
			placeholder="Filter sessions, projects, machines, #issues"
			autocomplete="off"
			onkeydown={(e) => { if (e.key === 'Escape') query = ''; }}
		/>
		<button type="button" class="kbd" title="Jump to a session or project" onclick={() => (quickSwitch.open = true)}>Ctrl K</button>
	</label>

	<div class="railwrap">
		<ProjectRail
			{tiles}
			selected={query.trim() ? '' : chosen ? chosen.key : 'active'}
			{activeBadge}
			onselect={openProject}
			onmove={moveProject}
		/>
		<div class="railmain">
			{#if query.trim()}
				{#if found.length === 0}
					<div class="empty">Nothing matches “{query}”.</div>
				{/if}
				{#each found as { card, places } (card.key)}
					<section class="group">
						{@render groupHead(card)}
						{#each places as place (place.key)}
							{@render placeRows(place, card.spans, false)}
						{/each}
					</section>
				{/each}
			{:else if chosen}
				{@render projectView(chosen)}
			{:else}
				<div class="rhead">
					<span class="bolt"><iconify-icon icon="mdi:lightning-bolt-outline"></iconify-icon></span>
					<div class="rtext">
						<div class="rname">Active</div>
						<div class="rsub">wants you, working, just finished</div>
					</div>
				</div>
				<NeedsYou machines={fleetStore.visible} fleet={fleetStore.fleet} onOpen={(m, t) => openSession(m, t)} onStart={startTicket} />
				{@render offlineLines(fleetStore.visible)}
				{#each activeGroups as { card, places } (card.key)}
					<section class="group">
						{@render groupHead(card)}
						{#each places as place (place.key)}
							{@render placeRows(place, card.spans, false)}
						{/each}
					</section>
				{/each}
				{#if activeGroups.length === 0}
					<div class="empty">
						{#if cards.length === 0}
							No projects yet. <button type="button" class="link" onclick={newProject}>Open a folder</button> to start.
						{:else}
							Nothing is going on. Pick a project on the rail.
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<QuickSwitch bind:open={quickSwitch.open} items={switchItems} />

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
	/* The composer's surface, borrowed. Low weight: no card boxes, quiet marks. */
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
		flex: 1;
		min-height: 0;
		height: 100%;
		padding-top: 10px;
		font-size: 13px;
		color: var(--text);
	}

	/* ── header ─────────────────────────────────────────────── */
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
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
	.panel :global(.ghost[data-state='open']) {
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
	.search {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		margin: 0 10px;
		padding: 0 4px 0 9px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		cursor: text;
	}
	.search:focus-within {
		border-color: #3f3f46;
	}
	.search iconify-icon {
		font-size: 15px;
		color: var(--dim);
	}
	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 12.5px;
		outline: none;
	}
	.search input::placeholder {
		color: var(--dim);
	}
	.kbd {
		flex: none;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--surface-2);
		color: var(--dim);
		font-family: var(--font-mono);
		font-size: 10.5px;
		padding: 1px 6px;
		cursor: pointer;
	}
	.kbd:hover {
		color: var(--muted);
	}
	@media (hover: none) {
		.kbd {
			display: none;
		}
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
	:global(.menu.pmenu) {
		width: 250px;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 32px;
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

	/* ── the rail and the list beside it ────────────────────── */
	.railwrap {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 52px minmax(0, 1fr);
		border-top: 1px solid var(--line-soft);
	}
	.railmain {
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		padding: 8px 8px 16px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	/* A finger needs more room at the foot. */
	@media (pointer: coarse) {
		.railmain {
			padding-bottom: 24px;
		}
	}
	.rhead {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 2px 2px 8px;
	}
	.rtext {
		flex: 1;
		min-width: 0;
	}
	.rname {
		font-size: 14.5px;
		font-weight: 650;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rsub {
		font-size: 11.5px;
		color: var(--dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bolt {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		flex: none;
		border-radius: 9px;
		background: var(--surface-3);
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding-bottom: 6px;
	}
	.ghead {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 6px 6px 3px;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: 8px;
	}
	.gname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.ghead:hover .gname {
		color: var(--text);
	}
	.nothing {
		padding: 4px 6px 6px;
		font-size: 12px;
		color: var(--dim);
	}
	/* One machine's share of a project; an offline machine's is inert and dimmed. */
	.place {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.place.off {
		opacity: 0.45;
		filter: grayscale(0.6);
	}
	.newrow {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding-top: 6px;
	}
	.newbtn {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 9px;
		border: 1px dashed var(--line);
		border-radius: 9px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 12.5px;
		text-align: left;
		cursor: pointer;
	}
	.newbtn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--dim);
		background: var(--surface-2);
	}
	.newbtn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.newbtn iconify-icon {
		font-size: 15px;
	}
	.newbtn .on {
		color: var(--dim);
	}
	.newbtn .where {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (hover: none) {
		.newbtn {
			min-height: 44px;
		}
	}
	.mach {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--m);
	}
	.offline {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px 6px;
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
		padding: 18px 6px;
		color: var(--dim);
		font-size: 12.5px;
	}
	.link {
		border: 0;
		background: none;
		color: var(--muted);
		text-decoration: underline dotted;
		font: inherit;
		cursor: pointer;
	}

	/* ── threads: what a session spawned hangs under it ── */
	.thread {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin-left: 13px;
		padding-left: 9px;
	}
	.thread.worker {
		border-left: 1px solid color-mix(in oklab, #4c3a8a 80%, transparent);
	}
	/* Workers side by side share one unbroken thread. */
	.thread.worker + .thread.worker {
		margin-top: -1px;
		padding-top: 1px;
	}
	.thread.agents {
		gap: 0;
		border-left: 1px dashed #155e63;
		margin-top: 1px;
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

	/* Settled: settled live sessions and past ones, folded at the list's foot */
	.livezone {
		border-radius: 10px;
		outline: 1px dashed transparent;
		outline-offset: 2px;
	}
	.livezone.drop {
		outline-color: var(--muted);
	}
	.settled {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin-top: 12px;
		padding-top: 6px;
		border-top: 1px solid var(--line);
	}
	.shead {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 30px;
		padding: 0 7px 0 3px;
		border: 1px dashed transparent;
		border-radius: 9px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.shead:hover {
		color: var(--text);
	}
	.shead.drop {
		border-color: var(--muted);
		background: var(--surface-2);
	}
	.shead .n {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
	}
	.shead .hint {
		margin-left: auto;
		font-size: 11px;
		color: var(--dim);
	}
	.chev {
		font-size: 16px;
		transition: transform 120ms ease;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.chev {
			transition: none;
		}
	}
	.row.past .name {
		color: var(--muted);
		font-size: 12.5px;
	}
	.row.past:hover .name {
		color: var(--text);
	}
	.row.past.off {
		opacity: 0.5;
	}
	.row.past .later {
		grid-column: 2 / -1;
		font-size: 11px;
		color: var(--dim);
	}
	.row .mach {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--m);
	}
	.more {
		align-self: flex-start;
		margin: 2px 0 0 30px;
		border: 0;
		background: none;
		color: var(--dim);
		font: inherit;
		font-size: 11.5px;
		text-decoration: underline dotted;
		cursor: pointer;
	}
	.more:hover {
		color: var(--muted);
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
