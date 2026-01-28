import { browser } from '$app/environment';

export interface Session {
	v: number;
	id: string;
	pid: number;
	cwd: string;
	git_root: string | null;
	beads_enabled: boolean;
	tmux_target: string | null;
	state: 'busy' | 'idle' | 'waiting' | 'permission';
	current_action: string | null;
	prompt_text: string | null;
	last_update: number;
	pane_title?: string | null;
}

class SessionStore {
	sessions = $state<Session[]>([]);
	paused = $state(false);
	connected = $state(false);

	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// Saved projects from localStorage
	savedProjects = $state<string[]>([]);

	connect(): void {
		if (!browser || this.ws) return;

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		this.ws = new WebSocket(`${protocol}//${window.location.host}/api/sessions/stream`);

		this.ws.onopen = () => {
			this.connected = true;
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = null;
			}
		};

		this.ws.onmessage = (event) => {
			if (this.paused) return;
			const data = JSON.parse(event.data);
			if (data.sessions) {
				this.sessions = data.sessions;
			}
		};

		this.ws.onclose = () => {
			this.connected = false;
			this.ws = null;
			// Reconnect after 2 seconds
			this.reconnectTimer = setTimeout(() => this.connect(), 2000);
		};

		this.ws.onerror = () => {
			this.ws?.close();
		};
	}

	disconnect(): void {
		// Cancel reconnect timer first
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		this.connected = false;

		if (this.ws) {
			// Remove handlers to prevent any callbacks
			this.ws.onopen = null;
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			// Close if not already closed
			if (this.ws.readyState !== WebSocket.CLOSED) {
				this.ws.close();
			}
			this.ws = null;
		}
	}

	togglePause(): void {
		this.paused = !this.paused;
	}

	loadSavedProjects(): void {
		if (!browser) return;
		try {
			this.savedProjects = JSON.parse(localStorage.getItem('claude-watch-projects') || '[]');
		} catch {
			this.savedProjects = [];
		}
	}

	saveProject(cwd: string): void {
		if (!browser || this.savedProjects.includes(cwd)) return;
		this.savedProjects = [...this.savedProjects, cwd];
		localStorage.setItem('claude-watch-projects', JSON.stringify(this.savedProjects));
	}

	removeProject(cwd: string): void {
		this.savedProjects = this.savedProjects.filter((p) => p !== cwd);
		localStorage.setItem('claude-watch-projects', JSON.stringify(this.savedProjects));
	}
}

export const sessionStore = new SessionStore();

// Helper functions
export function stateColor(state: string): string {
	switch (state) {
		case 'permission':
		case 'waiting':
			return '#e74c3c';
		case 'idle':
			return '#f39c12';
		case 'busy':
			return '#27ae60';
		default:
			return '#666';
	}
}

export function getProjectColor(cwd: string): string {
	// Generate a consistent color based on path hash
	let hash = 0;
	for (let i = 0; i < cwd.length; i++) {
		hash = cwd.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 60%, 40%)`;
}
