import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';

class TerminalStore extends ReliableWebSocket {
	output = $state('');

	private target: string | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSentSize: { cols: number; rows: number } | null = null;

	protected getWsUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const encodedTarget = encodeURIComponent(this.target!);
		return `${protocol}//${window.location.host}/api/sessions/${encodedTarget}/stream`;
	}

	protected getLogPrefix(): string {
		return '[terminal]';
	}

	protected shouldReconnect(): boolean {
		return this.target !== null;
	}

	protected handleMessage(event: MessageEvent): void {
		const data = JSON.parse(event.data);
		if (data.output !== undefined) {
			this.output = data.output;
		}
	}

	connect(target: string | null | undefined): void {
		if (!browser || !target) return;

		// If already connected to the same target, do nothing
		if (this.ws && this.target === target) return;

		// If connected to a different target, close old connection first
		if (this.ws) {
			// Disconnect without allowing reconnect (target will be null temporarily)
			const oldTarget = this.target;
			this.target = null; // Prevent reconnect in doDisconnect
			this.doDisconnect();
			this.target = oldTarget;
		}

		// Clear output when switching to a different target
		if (this.target !== target) {
			this.output = '';
		}

		this.target = target;
		this.doConnect();
	}

	disconnect(): void {
		// Cancel resize timer
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.lastSentSize = null;

		// Clear target before disconnecting to prevent reconnect
		this.target = null;
		this.doDisconnect();
	}

	sendResize(cols: number, rows: number): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

		// Skip if same as last sent
		if (this.lastSentSize?.cols === cols && this.lastSentSize?.rows === rows) return;

		// Debounce
		if (this.resizeTimer) clearTimeout(this.resizeTimer);

		this.resizeTimer = setTimeout(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
				this.lastSentSize = { cols, rows };
			}
			this.resizeTimer = null;
		}, 150);
	}
}

export const terminalStore = new TerminalStore();
