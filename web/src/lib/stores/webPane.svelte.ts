import { createPersisted } from './persisted';

const persisted = createPersisted<Record<string, string>>('claude-mux-web-pane', {});

/**
 * The URL the Web pane last showed, per session id: `prod`, `dev`, or a URL
 * typed by hand. The pane reopens it when the page's URL names none.
 */
class WebPaneStore {
	private state = $state<Record<string, string>>(persisted.load());

	get(id: string | null): string | null {
		return (id && this.state[id]) || null;
	}

	set(id: string | null, url: string): void {
		if (!id || this.state[id] === url) return;
		this.state[id] = url;
		persisted.save(this.state);
	}
}

export const webPaneStore = new WebPaneStore();
