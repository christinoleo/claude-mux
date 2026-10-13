import { ReliableWebSocket } from './websocket-base.svelte';
import type { BrowserWsMessage } from '$lib/side-panel/browser';

type Frame = Extract<BrowserWsMessage, { type: 'frame' }>;

/**
 * The Web pane's connection to one remote browser tab: frames come in, input
 * goes out. The server holds the tab's DevTools connection only while a
 * socket like this one is open, so closing it is what ends the screencast.
 */
export class BrowserStream extends ReliableWebSocket {
	/** Why the server ended the stream (the tab or the browser went away), until the next `open`. */
	closedReason = $state<string | null>(null);
	/** Where the tab has navigated to since the stream opened. */
	url = $state<string | null>(null);
	/** Called with each frame; the canvas draws it. */
	onFrame: ((frame: Frame) => void) | null = null;

	private tabId: string | null = null;

	/** Show `tabId`. Opening the tab already open does nothing unless `again`. */
	open(tabId: string, again = false): void {
		if (this.tabId === tabId && !again && this.closedReason === null) return;
		this.doDisconnect();
		this.tabId = tabId;
		this.closedReason = null;
		this.url = null;
		this.resetReceived();
		this.doConnect();
	}

	close(): void {
		this.tabId = null;
		this.doDisconnect();
	}

	/** Send one input message; it is dropped when the socket is not up. */
	input(msg: object): void {
		this.send(JSON.stringify(msg));
	}

	protected getWsUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${window.location.host}/api/browser/${encodeURIComponent(this.tabId!)}/stream`;
	}

	protected getLogPrefix(): string {
		return '[browser]';
	}

	protected shouldReconnect(): boolean {
		return this.tabId !== null && this.closedReason === null;
	}

	protected handleMessage(event: MessageEvent): void {
		let msg: BrowserWsMessage;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		if (msg.type === 'frame') this.onFrame?.(msg);
		else if (msg.type === 'nav') this.url = msg.url;
		else if (msg.type === 'closed') this.closedReason = msg.reason;
	}
}
