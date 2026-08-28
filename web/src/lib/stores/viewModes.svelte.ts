import { createPersisted } from './persisted';

export type ViewMode = 'transcript' | 'terminal';

const DEFAULT_MODE: ViewMode = 'transcript';
const persisted = createPersisted<Record<string, ViewMode>>('claude-mux-view-modes', {});

// Which view (transcript or raw terminal) the user last chose, per pane target.
// The URL still wins when it carries `?view=`; this only supplies the default
// for a session opened without one, so each session reopens the way it was left.
class ViewModesStore {
	private state = $state<Record<string, ViewMode>>(persisted.load());

	get(target: string | null): ViewMode {
		if (!target) return DEFAULT_MODE;
		return this.state[target] ?? DEFAULT_MODE;
	}

	set(target: string | null, mode: ViewMode): void {
		if (!target) return;
		if (this.state[target] === mode) return;
		if (mode === DEFAULT_MODE) delete this.state[target];
		else this.state[target] = mode;
		persisted.save(this.state);
	}
}

export const viewModesStore = new ViewModesStore();
