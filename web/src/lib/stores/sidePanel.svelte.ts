import { createPersisted } from './persisted';

/** What a session's side panel keeps between visits; the URL holds which pane is open. */
export interface PanelPrefs {
	/** The inline column's width in px, set by a drag; unset means the default width. */
	width?: number;
	/** The panel takes the whole page. */
	maximized?: boolean;
	/** The pane last opened, which the close key reopens. */
	last?: string;
}

const persisted = createPersisted<Record<string, PanelPrefs>>('claude-mux-side-panel', {});

/** The side panel's per-session preferences, keyed by pane target. */
class SidePanelStore {
	private state = $state<Record<string, PanelPrefs>>(persisted.load());

	get(target: string | null): PanelPrefs {
		return (target && this.state[target]) || {};
	}

	update(target: string | null, patch: PanelPrefs): void {
		if (!target) return;
		this.state[target] = { ...this.state[target], ...patch };
		persisted.save(this.state);
	}
}

export const sidePanelStore = new SidePanelStore();
