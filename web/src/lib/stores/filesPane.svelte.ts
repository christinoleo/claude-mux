import { createPersisted } from './persisted';

/** What the Files pane keeps per session between visits; the URL holds the open file. */
export interface FilesPrefs {
	/** Directories open in the tree, relative to the project root. */
	expanded?: string[];
	/** The file last open, which the pane reopens when the URL names none. */
	file?: string;
	/** List the entries git ignores. */
	showIgnored?: boolean;
}

const persisted = createPersisted<Record<string, FilesPrefs>>('claude-mux-files-pane', {});

/** The Files pane's per-session preferences, keyed by pane target. */
class FilesPaneStore {
	private state = $state<Record<string, FilesPrefs>>(persisted.load());

	get(target: string | null): FilesPrefs {
		return (target && this.state[target]) || {};
	}

	update(target: string | null, patch: FilesPrefs): void {
		if (!target) return;
		this.state[target] = { ...this.state[target], ...patch };
		persisted.save(this.state);
	}
}

export const filesPaneStore = new FilesPaneStore();
