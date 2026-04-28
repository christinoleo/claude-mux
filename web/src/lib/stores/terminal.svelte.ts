import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';

// Must match server constants in ws-handlers.ts.
const DEFAULT_HISTORY = 150;
const MAX_HISTORY = 5000;

class TerminalStore extends ReliableWebSocket {
	output = $state('');
	historyLines = $state(DEFAULT_HISTORY);
	loadingMore = $state(false);

	private target: string | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSentSize: { cols: number; rows: number } | null = null;
	private pendingHistory: (() => void) | null = null;

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
			if (this.loadingMore) {
				this.loadingMore = false;
				const resolve = this.pendingHistory;
				this.pendingHistory = null;
				resolve?.();
			}
		}
	}

	/**
	 * Single entry point for terminal state. Pass a tmux target to view it,
	 * or `null` to detach. Owns WS lifecycle, output clearing, and history
	 * reset as one transaction so callers don't reason about connection state.
	 */
	setTarget(target: string | null | undefined): void {
		if (!browser) return;
		const next = target ?? null;

		// Same target: either no-op, or reattach the WS without clearing output.
		// Preserves the buffer across transient disconnects (network blip, server reload).
		if (this.target === next) {
			if (next === null) return;
			if (this.ws) return;
			this.doConnect();
			return;
		}

		// Switching target (or first attach): tear down old WS and reset view state.
		if (this.ws) {
			this.target = null; // suppress reconnect in doDisconnect
			this.doDisconnect();
		}
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.lastSentSize = null;
		this.output = '';
		this.resetHistoryState();
		this.target = next;

		if (next) this.doConnect();
	}

	/** Resolves when the expanded buffer arrives. Returns null if no request was sent. */
	requestMoreHistory(): Promise<void> | null {
		if (this.loadingMore) return null;
		if (this.historyLines >= MAX_HISTORY) return null;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
		const next = Math.min(MAX_HISTORY, this.historyLines * 2);
		this.historyLines = next;
		this.loadingMore = true;
		this.ws.send(JSON.stringify({ type: 'set_history', lines: next }));
		return new Promise<void>((resolve) => {
			this.pendingHistory = resolve;
		});
	}

	get historyAtMax(): boolean {
		return this.historyLines >= MAX_HISTORY;
	}

	private resetHistoryState(): void {
		this.historyLines = DEFAULT_HISTORY;
		this.loadingMore = false;
		const resolve = this.pendingHistory;
		this.pendingHistory = null;
		resolve?.();
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
