import { browser } from '$app/environment';

class TerminalStore {
	output = $state('');
	connected = $state(false);

	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private target: string | null = null;

	connect(target: string | null | undefined): void {
		if (!browser || !target) return;

		// If already connected to the same target, do nothing
		if (this.ws && this.target === target) return;

		// Cancel any pending reconnect timer
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// If connected to a different target, close old connection first
		if (this.ws) {
			// Remove handlers to prevent reconnect attempts
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

		// Clear output when switching to a different target
		if (this.target !== target) {
			this.output = '';
		}

		this.target = target;
		this.connected = false;

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const encodedTarget = encodeURIComponent(target);
		this.ws = new WebSocket(`${protocol}//${window.location.host}/api/sessions/${encodedTarget}/stream`);

		this.ws.onopen = () => {
			this.connected = true;
		};

		this.ws.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.output !== undefined) {
				this.output = data.output;
			}
		};

		this.ws.onclose = () => {
			this.connected = false;
			this.ws = null;
			// Reconnect after 2 seconds if we still have a target
			if (this.target) {
				this.reconnectTimer = setTimeout(() => this.connect(this.target!), 2000);
			}
		};

		this.ws.onerror = () => {
			// onclose will be called after this
		};
	}

	disconnect(): void {
		// Cancel reconnect timer first
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// Clear target before closing to prevent reconnect in onclose
		this.target = null;
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
}

export const terminalStore = new TerminalStore();
