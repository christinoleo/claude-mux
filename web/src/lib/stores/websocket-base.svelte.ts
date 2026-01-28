import { browser } from '$app/environment';

/**
 * Configuration for reliable WebSocket connections.
 * Tuned for mobile networks where connections drop frequently.
 */
export interface WebSocketConfig {
	/** Keep-alive ping interval in ms (default: 30s) */
	pingInterval?: number;
	/** Max time to wait for pong before considering connection dead (default: 10s) */
	pongTimeout?: number;
	/** Initial reconnect delay in ms (default: 1s) */
	baseReconnectDelay?: number;
	/** Maximum reconnect delay in ms (default: 30s) */
	maxReconnectDelay?: number;
}

const DEFAULT_CONFIG: Required<WebSocketConfig> = {
	pingInterval: 30000,
	pongTimeout: 10000,
	baseReconnectDelay: 1000,
	maxReconnectDelay: 30000
};

/**
 * Base class for reliable WebSocket connections with:
 * - Ping/pong keep-alive for detecting stale connections
 * - Exponential backoff with jitter for reconnection
 * - Visibility change handling for mobile background/foreground transitions
 */
export abstract class ReliableWebSocket {
	connected = $state(false);

	protected ws: WebSocket | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPong: number = 0;
	private reconnectAttempts: number = 0;
	private visibilityHandler: (() => void) | null = null;
	private config: Required<WebSocketConfig>;

	constructor(config?: WebSocketConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Subclass must provide the WebSocket URL */
	protected abstract getWsUrl(): string;

	/** Subclass must handle incoming messages (after pong filtering) */
	protected abstract handleMessage(event: MessageEvent): void;

	/** Subclass can override to control reconnection (e.g., only reconnect if target is set) */
	protected shouldReconnect(): boolean {
		return true;
	}

	/** Subclass can override to run code on successful connection */
	protected onConnected(): void {}

	/** Subclass can override to run code on disconnection */
	protected onDisconnected(): void {}

	/** Get the log prefix for debug messages */
	protected abstract getLogPrefix(): string;

	protected doConnect(): void {
		if (!browser || this.ws) return;

		const url = this.getWsUrl();
		this.ws = new WebSocket(url);

		this.ws.onopen = () => {
			this.connected = true;
			this.reconnectAttempts = 0;
			this.lastPong = Date.now();
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = null;
			}
			this.startPingTimer();
			this.setupVisibilityHandler();
			this.onConnected();
		};

		this.ws.onmessage = (event) => {
			// Handle pong response
			if (event.data === 'pong') {
				this.lastPong = Date.now();
				return;
			}
			this.handleMessage(event);
		};

		this.ws.onclose = () => {
			this.connected = false;
			this.ws = null;
			this.stopPingTimer();
			this.onDisconnected();
			if (this.shouldReconnect()) {
				this.scheduleReconnect();
			}
		};

		this.ws.onerror = () => {
			this.ws?.close();
		};
	}

	protected doDisconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		this.stopPingTimer();
		this.removeVisibilityHandler();
		this.connected = false;
		this.reconnectAttempts = 0;

		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			if (this.ws.readyState !== WebSocket.CLOSED) {
				this.ws.close();
			}
			this.ws = null;
		}
	}

	/** Force reconnection (resets backoff) */
	protected forceReconnect(): void {
		this.reconnectAttempts = 0;
		if (this.ws) {
			this.ws.onclose = null; // Prevent normal onclose from scheduling reconnect
			this.ws.close();
			this.ws = null;
		}
		this.stopPingTimer();
		this.connected = false;
		this.doConnect();
	}

	private startPingTimer(): void {
		this.stopPingTimer();
		this.pingTimer = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				// Check if connection is stale (no pong received recently)
				if (Date.now() - this.lastPong > this.config.pingInterval + this.config.pongTimeout) {
					if (import.meta.env.DEV) console.debug(`${this.getLogPrefix()} Connection stale, forcing reconnect`);
					this.ws?.close();
					return;
				}
				this.ws.send('ping');
			}
		}, this.config.pingInterval);
	}

	private stopPingTimer(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;

		// Exponential backoff with jitter
		const delay = Math.min(
			this.config.baseReconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
			this.config.maxReconnectDelay
		);
		this.reconnectAttempts++;

		if (import.meta.env.DEV) console.debug(`${this.getLogPrefix()} Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.doConnect();
		}, delay);
	}

	private setupVisibilityHandler(): void {
		if (this.visibilityHandler) return;

		this.visibilityHandler = () => {
			if (document.visibilityState === 'visible' && this.shouldReconnect()) {
				if (import.meta.env.DEV) console.debug(`${this.getLogPrefix()} Page visible, checking connection`);
				if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
					if (import.meta.env.DEV) console.debug(`${this.getLogPrefix()} Connection lost while hidden, reconnecting`);
					this.forceReconnect();
				} else {
					// Send a ping to verify connection is alive
					this.ws.send('ping');
				}
			}
		};

		document.addEventListener('visibilitychange', this.visibilityHandler);
	}

	private removeVisibilityHandler(): void {
		if (this.visibilityHandler) {
			document.removeEventListener('visibilitychange', this.visibilityHandler);
			this.visibilityHandler = null;
		}
	}
}
