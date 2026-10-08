/**
 * The pane kinds the side panel can show. A pane registers here: its kind
 * (the `?panel=` value), icon, label, the key that toggles it, the URL params
 * it owns, its body component, and when it cannot apply. Its header actions
 * come from the body itself, through `setActions`, since they usually depend
 * on what the body is showing.
 */
import type { Component } from 'svelte';
import type { Session } from '$lib/stores/sessions.svelte';
import type { ChangesInfo } from '$shared/types/ws-messages.js';
import ProjectPane from '$lib/components/side-panel/ProjectPane.svelte';
import { IS_MAC } from '$lib/constants';

export interface PaneAction {
	icon: string;
	label: string;
	run: () => void;
	/** For an action that toggles, whether it is on. */
	pressed?: boolean;
	disabled?: boolean;
}

export interface PaneBodyProps {
	session: Session | null;
	target: string;
	/** The params this pane owns, as the URL has them. */
	params: Record<string, string>;
	/** Change this pane's params; a null value removes one. Replaces the history entry unless `push`. */
	setParams: (own: Record<string, string | null>, opts?: { push?: boolean }) => void;
	/** The actions the panel header draws beside the pane's title. */
	setActions: (actions: PaneAction[]) => void;
	/** The pane is the one showing; a hidden pane stays mounted but may idle. */
	active: boolean;
}

export interface PaneDef {
	kind: string;
	label: string;
	icon: string;
	/** The letter that, with Alt+Shift, toggles this pane. */
	key: string;
	/** The query params this pane owns besides `panel`. */
	params: readonly string[];
	body: Component<PaneBodyProps>;
	/** Why the pane cannot apply to this session, or null when it can. */
	unavailable?: (session: Session | null) => string | null;
	/** Lines added and removed, drawn on the pane's toggle while non-zero. */
	count?: (session: Session | null) => ChangesInfo | null;
}

export const PANES: readonly PaneDef[] = [
	{
		kind: 'project',
		label: 'Project',
		icon: 'mdi:folder-information-outline',
		key: 'P',
		params: [],
		body: ProjectPane,
		unavailable: (s) => (s ? null : 'Not a Claude session')
	}
];

export const PANE_KINDS = PANES.map((p) => p.kind);
/** Every param any pane owns, which switching panes clears. */
export const PANE_PARAMS = [...new Set(PANES.flatMap((p) => p.params))];

export function paneDef(kind: string | null): PaneDef | null {
	return PANES.find((p) => p.kind === kind) ?? null;
}

/** How Alt+Shift+`letter` is written for this keyboard. */
function altShift(letter: string): string {
	return IS_MAC ? `⌥⇧${letter}` : `Alt Shift ${letter}`;
}

/** How the keys that toggle a pane are written for this keyboard. */
export function paneKeys(def: PaneDef): string {
	return altShift(def.key);
}
/** Toggles maximize. */
const MAXIMIZE_KEY = 'M';
export const MAXIMIZE_KEYS = altShift(MAXIMIZE_KEY);
/** Closes the panel, or reopens the pane last shown. */
export const CLOSE_KEYS = IS_MAC ? '⌘\\' : 'Ctrl \\';

/** The pane an Alt+Shift+letter press names, or 'maximize'. */
export function panelKeyAction(e: KeyboardEvent): PaneDef | 'maximize' | 'toggle' | null {
	if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Backslash') return 'toggle';
	if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
	if (e.code === `Key${MAXIMIZE_KEY}`) return 'maximize';
	return PANES.find((p) => e.code === `Key${p.key}`) ?? null;
}
