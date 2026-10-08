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

/** The Files pane's per-session preferences, keyed by session id: a pane target is reused by later sessions. */
class FilesPaneStore {
	private state = $state<Record<string, FilesPrefs>>(persisted.load());

	get(id: string | null): FilesPrefs {
		return (id && this.state[id]) || {};
	}

	update(id: string | null, patch: FilesPrefs): void {
		if (!id) return;
		this.state[id] = { ...this.state[id], ...patch };
		persisted.save(this.state);
	}
}

export const filesPaneStore = new FilesPaneStore();
