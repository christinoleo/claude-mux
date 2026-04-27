import { browser } from '$app/environment';
import type { TmuxPane } from '$lib/types/tmux';

const POLL_INTERVAL_MS = 5000;

function panesEqual(a: TmuxPane[], b: TmuxPane[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.target !== y.target || x.command !== y.command || x.cwd !== y.cwd || x.session !== y.session) {
			return false;
		}
	}
	return true;
}

class TmuxPanesStore {
	panes = $state<TmuxPane[]>([]);
	loaded = $state(false);

	private interval: ReturnType<typeof setInterval> | null = null;
	private subscribers = 0;
	private pending = false;

	private fetchPanes = async () => {
		if (this.pending) return;
		this.pending = true;
		try {
			const res = await fetch('/api/tmux/panes');
			const next: TmuxPane[] = await res.json();
			if (!panesEqual(this.panes, next)) this.panes = next;
			this.loaded = true;
		} catch {
			// Keep existing panes; don't flip `loaded` so consumers don't render stale-dead state on transient failures
		} finally {
			this.pending = false;
		}
	};

	private start() {
		if (this.interval == null) this.interval = setInterval(this.fetchPanes, POLL_INTERVAL_MS);
	}

	private stop() {
		if (this.interval != null) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private onVis = () => {
		if (document.hidden) this.stop();
		else {
			this.fetchPanes();
			this.start();
		}
	};

	subscribe(): () => void {
		if (!browser) return () => {};
		this.subscribers++;
		if (this.subscribers === 1) {
			this.fetchPanes();
			this.start();
			document.addEventListener('visibilitychange', this.onVis);
		}
		return () => {
			this.subscribers--;
			if (this.subscribers === 0) {
				this.stop();
				document.removeEventListener('visibilitychange', this.onVis);
			}
		};
	}
}

export const tmuxPanesStore = new TmuxPanesStore();
