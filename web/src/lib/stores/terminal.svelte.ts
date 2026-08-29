import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';

/** History lines fetched on attach and per "load more" step. */
export const HISTORY_CHUNK = 200;
/** Max history lines kept in memory while the view sits at the bottom. */
const KEEP_AT_BOTTOM = 400;

interface ScreenMsg {
	type: 'screen';
	lines: string[];
	historySize: number;
	alt: boolean;
	cols: number;
	rows: number;
}
interface HistoryMsg {
	type: 'history';
	start: number;
	lines: string[];
	historySize: number;
}
interface ResetMsg {
	type: 'reset';
	historySize: number;
	alt: boolean;
	cols: number;
	rows: number;
}
type TerminalMsg = ScreenMsg | HistoryMsg | ResetMsg;

/**
 * Terminal view model.
 *
 * The server streams two regions: `screen` (visible pane, replaced on every
 * change) and `history` (lines that scrolled off the top — immutable, addressed
 * by absolute index, delivered as contiguous chunks). We hold one contiguous
 * history block [historyStart, historyStart + history.length) that always ends
 * at `historySize`, i.e. right above the screen. Because history only grows by
 * appending, content the user is reading never shifts; the page simply leaves
 * scrollTop alone while the user is scrolled up.
 */
class TerminalStore extends ReliableWebSocket {
	/** Visible pane rows (ANSI) */
	screen = $state<string[]>([]);
	/** Contiguous history block ending at historySize */
	history = $state<string[]>([]);
	/** Absolute index of history[0] */
	historyStart = $state(0);
	/** Server's #{history_size}: absolute index just past the last history line */
	historySize = $state(0);
	/** Pane is in alternate-screen mode (vim/less/Claude fullscreen TUI): no usable history */
	alt = $state(false);
	cols = $state(0);
	rows = $state(0);
	loadingMore = $state(false);
	/** Total history lines appended since attach (page diffs it to count unseen lines) */
	appended = $state(0);

	/** Page tells us whether the view is pinned to the bottom (so we may trim history) */
	atBottom = true;

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

	/** Oldest line is loaded — nothing more to fetch */
	get historyAtStart(): boolean {
		return this.alt || this.historyStart <= 0;
	}

	get historyEnd(): number {
		return this.historyStart + this.history.length;
	}

	protected handleMessage(event: MessageEvent): void {
		let data: TerminalMsg;
		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}
		switch (data.type) {
			case 'screen':
				this.applyScreen(data);
				break;
			case 'history':
				this.applyHistory(data);
				break;
			case 'reset':
				this.applyReset(data);
				break;
		}
	}

	private applyScreen(msg: ScreenMsg): void {
		this.screen = msg.lines;
		this.historySize = msg.historySize;
		this.alt = msg.alt;
		this.cols = msg.cols;
		this.rows = msg.rows;
		if (msg.alt && this.history.length) {
			this.history = [];
			this.historyStart = msg.historySize;
		}
		// Initial tail is pushed by the server on attach; after a reset we ask for it ourselves.
	}

	private applyReset(msg: ResetMsg): void {
		this.history = [];
		this.historyStart = msg.historySize;
		this.historySize = msg.historySize;
		this.alt = msg.alt;
		this.cols = msg.cols;
		this.rows = msg.rows;
		this.resolvePending();
		if (!msg.alt && msg.historySize > 0) {
			this.requestHistory(msg.historySize, HISTORY_CHUNK);
		}
	}

	private applyHistory(msg: HistoryMsg): void {
		const { start, lines } = msg;
		const end = start + lines.length;
		this.historySize = Math.max(this.historySize, msg.historySize);
		const isLoadMore = this.loadingMore;

		if (lines.length === 0) {
			// nothing (e.g. requested before index 0)
		} else if (this.history.length === 0) {
			this.history = lines;
			this.historyStart = start;
		} else {
			const curStart = this.historyStart;
			const curEnd = curStart + this.history.length;
			if (start <= curEnd && end > curEnd) {
				// Append (trim overlap)
				const fresh = lines.slice(curEnd - start);
				this.history.push(...fresh);
				this.appended += fresh.length;
				if (this.atBottom && this.history.length > KEEP_AT_BOTTOM) {
					const drop = this.history.length - KEEP_AT_BOTTOM;
					this.history.splice(0, drop);
					this.historyStart += drop;
				}
			} else if (end >= curStart && start < curStart) {
				// Prepend (trim overlap)
				const fresh = lines.slice(0, curStart - start);
				this.history.unshift(...fresh);
				this.historyStart = start;
			} else if (start > curEnd) {
				// Gap: we missed a delta (reconnect). Restart from this chunk.
				this.history = lines;
				this.historyStart = start;
				this.appended += lines.length;
			}
			// else: fully inside what we have, or entirely before — ignore
		}
		if (isLoadMore) {
			this.loadingMore = false;
			this.resolvePending();
		}
	}

	private resolvePending(): void {
		const resolve = this.pendingHistory;
		this.pendingHistory = null;
		resolve?.();
	}

	private requestHistory(before: number, count: number): void {
		this.send(JSON.stringify({ type: 'history_request', before, count }));
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
		this.clearView();
		this.target = next;

		if (next) this.doConnect();
	}

	private clearView(): void {
		this.screen = [];
		this.history = [];
		this.historyStart = 0;
		this.historySize = 0;
		this.alt = false;
		this.loadingMore = false;
		this.atBottom = true;
		this.appended = 0;
		this.resolvePending();
	}

	/** Resolves when the older chunk arrives. Returns null if no request was sent. */
	requestMoreHistory(count = HISTORY_CHUNK): Promise<void> | null {
		if (this.loadingMore) return null;
		if (this.historyAtStart) return null;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
		this.loadingMore = true;
		this.requestHistory(this.historyStart, count);
		return new Promise<void>((resolve) => {
			this.pendingHistory = resolve;
		});
	}

	/** Drop history beyond what we keep at the bottom (called when the user returns to bottom). */
	trimToBottom(): void {
		if (this.history.length > KEEP_AT_BOTTOM) {
			const drop = this.history.length - KEEP_AT_BOTTOM;
			this.history.splice(0, drop);
			this.historyStart += drop;
		}
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
