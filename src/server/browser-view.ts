/**
 * The Web pane's Browser source: a live, interactive view of a tab in the
 * remote browser a session drives through an MCP server.
 *
 * This server holds the DevTools (CDP) connection and relays it, so the page
 * showing the view only ever talks to claude-mux and never reaches the
 * browser's debugging port. The browser is the one `~/.claude.json` names: the
 * `mcpServers` entry whose arguments carry `--browserUrl`. Chrome accepts
 * several CDP clients on one target, so this sits beside the MCP server's own
 * connection.
 *
 * Nothing here closes, navigates, reorders or activates a tab: a viewer sees
 * the tab where it is. The one thing a viewer can do to a tab besides typing
 * and pointing at it is reload it.
 */

import { execFile } from 'child_process';
import { lookup } from 'dns/promises';
import { readFile, stat } from 'fs/promises';
import { isIP } from 'net';
import { relayOriginAllowed } from './fleet-relay.js';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { lastBrowserPage } from '../transcript/browser-tab.js';
import type { WsClient } from './ws-handlers.js';

const execFileAsync = promisify(execFile);

/** How long the browser gets to answer `/json/list`. */
const LIST_TIMEOUT_MS = 2_500;
/** How long a resolved address is kept; a failure is asked again sooner. */
const ENDPOINT_CACHE_MS = 60_000;
const ENDPOINT_RETRY_MS = 5_000;
/** How long one CDP request may go unanswered before its caller gives up. */
const REQUEST_TIMEOUT_MS = 5_000;
/** The least time between two frames, which paces the screencast's acks. */
const MIN_FRAME_MS = 66;
/** How long a screencast may stay silent after starting before screenshots take over. */
const STALL_MS = 1_500;
/** How often the screenshot fallback looks, while it is the one drawing. */
const SHOT_MS = 1_000;
/** A viewer this far behind misses frames rather than queueing them. */
const MAX_BUFFERED = 1024 * 1024;
const MAX_VIEWERS_PER_TAB = 10;
const MAX_TABS = 8;
const JPEG_QUALITY = 65;
/** Frames are scaled down to fit this box, in device pixels. */
const MAX_FRAME_PX = 1440;

// ── which browser ───────────────────────────────────────────────────────

/** The `--browserUrl` an MCP entry names, before any shell has seen it. */
export interface BrowserEntry {
	/** The entry's key in `mcpServers`, which is also the prefix of its tools. */
	name: string;
	/** The URL as written: it may hold a `$(…)` for a shell to resolve. */
	expr: string;
	/** The entry runs through `sh -c`, so `expr` is shell text. */
	shell: boolean;
}

export interface BrowserEndpoint {
	name: string;
	/** The debugging port's origin, by IP: Chrome refuses a Host header that is a hostname. */
	origin: string;
}

/**
 * One shell word starting at `from`: up to the first whitespace outside
 * quotes and `$(…)`. Enough for a URL holding a command substitution.
 */
function shellWord(script: string, from: number): string {
	let depth = 0;
	let quote: string | null = null;
	let i = from;
	for (; i < script.length; i++) {
		const c = script[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '(') {
			depth++;
		} else if (c === ')') {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && /\s|;|&|\|/.test(c)) {
			break;
		}
	}
	return script.slice(from, i);
}

/** The first `mcpServers` entry in a parsed `~/.claude.json` whose arguments carry `--browserUrl`. */
export function findBrowserEntry(config: unknown): BrowserEntry | null {
	const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
	if (!servers || typeof servers !== 'object') return null;
	for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
		const { command, args } = (entry ?? {}) as { command?: unknown; args?: unknown };
		if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) continue;
		const shell = typeof command === 'string' && /(^|\/)(ba|da|z)?sh$/.test(command) && args[0] === '-c';
		if (shell) {
			const m = /--browserUrl(?:=|\s+)/.exec(args[1] ?? '');
			if (!m) continue;
			const expr = shellWord(args[1], m.index + m[0].length);
			if (expr) return { name, expr, shell: true };
			continue;
		}
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '--browserUrl' && args[i + 1]) return { name, expr: args[i + 1], shell: false };
			if (args[i].startsWith('--browserUrl=')) return { name, expr: args[i].slice('--browserUrl='.length), shell: false };
		}
	}
	return null;
}

/**
 * The entry's URL as its own `sh -c` would expand it. Only the URL's word is
 * run, and only for an entry Claude Code already runs through a shell.
 */
async function resolveEntry(entry: BrowserEntry): Promise<BrowserEndpoint | null> {
	let text = entry.expr;
	if (entry.shell) {
		try {
			({ stdout: text } = await execFileAsync('sh', ['-c', `printf %s ${entry.expr}`], { timeout: 3_000 }));
		} catch {
			return null;
		}
	}
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (!isIP(host)) {
		try {
			const { address, family } = await lookup(host);
			url.hostname = family === 6 ? `[${address}]` : address;
		} catch {
			return null;
		}
	}
	return { name: entry.name, origin: url.origin };
}

let entryCache: { mtimeMs: number; entry: BrowserEntry | null } | null = null;

/** The browser entry in `~/.claude.json`, re-read only when the file changes. */
export async function browserEntry(): Promise<BrowserEntry | null> {
	const path = join(homedir(), '.claude.json');
	try {
		const { mtimeMs } = await stat(path);
		if (entryCache?.mtimeMs !== mtimeMs) {
			entryCache = { mtimeMs, entry: findBrowserEntry(JSON.parse(await readFile(path, 'utf-8'))) };
		}
		return entryCache.entry;
	} catch {
		return null;
	}
}

let endpointCache: { at: number; expr: string; endpoint: Promise<BrowserEndpoint | null> } | null = null;

/** Where the configured browser's debugging port is, or null when none is configured or it will not resolve. */
export async function browserEndpoint(): Promise<BrowserEndpoint | null> {
	const entry = await browserEntry();
	if (!entry) return null;
	const now = Date.now();
	if (endpointCache && endpointCache.expr === entry.expr) {
		const found = await endpointCache.endpoint;
		if (now - endpointCache.at < (found ? ENDPOINT_CACHE_MS : ENDPOINT_RETRY_MS)) return found;
	}
	endpointCache = { at: now, expr: entry.expr, endpoint: resolveEntry(entry) };
	return endpointCache.endpoint;
}

// ── its tabs ────────────────────────────────────────────────────────────

export interface BrowserTab {
	/** The CDP target id. */
	id: string;
	title: string;
	url: string;
}

/** What `GET /api/browser/tabs` answers. */
export interface BrowserInfo {
	/** The MCP entry the browser belongs to, or null when none is configured. */
	name: string | null;
	/** Why the browser could not be read, when it could not. */
	error: string | null;
	tabs: BrowserTab[];
	/** The tab the session last opened or selected, when it is still open. */
	preferred: string | null;
}

/** A CDP target id, and nothing that could steer the path it is put into. */
export function isTabId(id: string): boolean {
	return /^[A-Za-z0-9-]{8,64}$/.test(id);
}

/** The tabs in a `/json/list` answer: pages a person could look at, in the browser's order. */
export function parseTabs(list: unknown): BrowserTab[] {
	if (!Array.isArray(list)) return [];
	const tabs: BrowserTab[] = [];
	for (const t of list as Record<string, unknown>[]) {
		if (t?.type !== 'page' || typeof t.id !== 'string' || !isTabId(t.id)) continue;
		const url = typeof t.url === 'string' ? t.url : '';
		if (/^(devtools|chrome-extension):/.test(url)) continue;
		tabs.push({ id: t.id, title: typeof t.title === 'string' ? t.title : '', url });
	}
	return tabs;
}

async function listTabs(endpoint: BrowserEndpoint): Promise<BrowserTab[]> {
	const res = await fetch(`${endpoint.origin}/json/list`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return parseTabs(await res.json());
}

/** The open tab showing `url`, the way the MCP server last reported it. */
export function tabForUrl(tabs: BrowserTab[], url: string | null): string | null {
	if (!url) return null;
	const bare = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '');
	return (tabs.find((t) => t.url === url) ?? tabs.find((t) => bare(t.url) === bare(url)))?.id ?? null;
}

/**
 * The browser's tabs, and which of them the session whose transcript
 * `transcriptPath` finds last opened or selected. The path is only looked for
 * once there are tabs to match it against.
 */
export async function browserInfo(transcriptPath: () => string | null): Promise<BrowserInfo> {
	const none = { tabs: [], preferred: null };
	const entry = await browserEntry();
	if (!entry) return { name: null, error: null, ...none };
	const endpoint = await browserEndpoint();
	if (!endpoint) {
		return { name: entry.name, error: `Could not work out the address in ${entry.name}'s --browserUrl.`, ...none };
	}
	let tabs: BrowserTab[];
	try {
		tabs = await listTabs(endpoint);
	} catch {
		const host = new URL(endpoint.origin).host;
		return {
			name: entry.name,
			error: `The browser behind ${entry.name} did not answer at ${host}. Is that machine awake, and the browser running?`,
			...none
		};
	}
	const path = transcriptPath();
	const last = path ? await lastBrowserPage(path, entry.name) : null;
	return { name: entry.name, error: null, tabs, preferred: tabForUrl(tabs, last) };
}

// ── input ───────────────────────────────────────────────────────────────

export interface CdpCall {
	method: string;
	params: Record<string, unknown>;
}

const MOUSE_EVENTS: Record<string, string> = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' };
const TOUCH_EVENTS: Record<string, string> = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' };
const BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);
/** The longest text one message may type. */
const MAX_TEXT = 10_000;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const int = (v: unknown): number => (num(v) ? Math.trunc(v) : 0);

/**
 * The CDP call a viewer's message stands for, or null when it stands for none.
 * This is the whole of what a viewer can make the browser do, so a message is
 * rebuilt field by field rather than passed through.
 */
export function toCdpInput(msg: unknown): CdpCall | null {
	if (!msg || typeof msg !== 'object') return null;
	const m = msg as Record<string, unknown>;
	const modifiers = int(m.modifiers) & 15;
	switch (m.type) {
		case 'mouse': {
			const type = MOUSE_EVENTS[String(m.event)];
			if (!type || !num(m.x) || !num(m.y)) return null;
			const button = typeof m.button === 'string' && BUTTONS.has(m.button) ? m.button : 'none';
			return {
				method: 'Input.dispatchMouseEvent',
				params: { type, x: m.x, y: m.y, button, buttons: int(m.buttons) & 31, clickCount: Math.min(Math.max(int(m.clickCount), 0), 3), modifiers }
			};
		}
		case 'wheel':
			if (!num(m.x) || !num(m.y) || !num(m.deltaX) || !num(m.deltaY)) return null;
			return {
				method: 'Input.dispatchMouseEvent',
				params: { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.deltaX, deltaY: m.deltaY, modifiers }
			};
		case 'key': {
			if ((m.event !== 'down' && m.event !== 'up') || !str(m.key) || !str(m.code)) return null;
			const text = m.event === 'down' && str(m.text, 8) && m.text ? m.text : undefined;
			const keyCode = int(m.keyCode);
			return {
				method: 'Input.dispatchKeyEvent',
				params: {
					type: m.event === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
					key: m.key,
					code: m.code,
					windowsVirtualKeyCode: keyCode,
					nativeVirtualKeyCode: keyCode,
					modifiers,
					...(text ? { text, unmodifiedText: text } : {})
				}
			};
		}
		case 'text':
			if (!str(m.text, MAX_TEXT) || !m.text) return null;
			return { method: 'Input.insertText', params: { text: m.text } };
		case 'touch': {
			const type = TOUCH_EVENTS[String(m.event)];
			if (!type || !Array.isArray(m.points) || m.points.length > 10) return null;
			const touchPoints = [];
			for (const p of m.points as Record<string, unknown>[]) {
				if (!p || !num(p.x) || !num(p.y)) return null;
				touchPoints.push({ x: p.x, y: p.y, id: int(p.id) });
			}
			return { method: 'Input.dispatchTouchEvent', params: { type, touchPoints, modifiers } };
		}
		case 'reload':
			return { method: 'Page.reload', params: {} };
	}
	return null;
}

// ── the stream ──────────────────────────────────────────────────────────

/** What the stream sends a viewer. */
export type BrowserWsMessage =
	/** One JPEG, base64, and the size in CSS pixels of the viewport it shows. */
	| { type: 'frame'; data: string; width: number; height: number }
	/** The tab's main frame went to another URL. */
	| { type: 'nav'; url: string }
	/** The tab is gone, or the browser is; the socket closes after this. */
	| { type: 'closed'; reason: string };

/** The part of a WebSocket the stream uses, so a test can stand in for the browser. */
export interface CdpSocket {
	send(data: string): void;
	close(): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export interface BrowserWsDeps {
	connect?: (url: string) => CdpSocket;
	endpoint?: () => Promise<BrowserEndpoint | null>;
}

/** One tab's CDP connection and the viewers it feeds. It lives exactly as long as it has a viewer. */
class TabStream {
	readonly viewers = new Set<WsClient>();
	private socket: CdpSocket | null = null;
	private open = false;
	private ended = false;
	private nextId = 0;
	private readonly pending = new Map<number, (result: Record<string, unknown> | null) => void>();
	/** The last frame sent, for a viewer who joins a page that is not repainting. */
	private lastFrame: string | null = null;
	private lastShot = '';
	private lastFrameAt = 0;
	private startedAt = 0;
	private gotScreencast = false;
	private visible = true;
	private shooting = false;
	private shotTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly tabId: string,
		private readonly deps: Required<BrowserWsDeps>,
		private readonly onEnd: () => void
	) {
		void this.start();
	}

	private async start(): Promise<void> {
		const endpoint = await this.deps.endpoint().catch(() => null);
		if (this.ended) return;
		if (!endpoint) return this.end('No browser to connect to.');
		let socket: CdpSocket;
		try {
			socket = this.deps.connect(`${endpoint.origin.replace(/^http/, 'ws')}/devtools/page/${this.tabId}`);
		} catch {
			return this.end('Could not reach the browser.');
		}
		this.socket = socket;
		socket.onopen = () => {
			this.open = true;
			this.startedAt = Date.now();
			this.send('Page.enable');
			this.send('Page.startScreencast', {
				format: 'jpeg',
				quality: JPEG_QUALITY,
				maxWidth: MAX_FRAME_PX,
				maxHeight: MAX_FRAME_PX,
				everyNthFrame: 1
			});
			this.shotTimer = setInterval(() => this.checkStall(), SHOT_MS);
		};
		socket.onmessage = (ev) => this.onCdp(String(ev.data));
		socket.onerror = () => this.end('Could not reach the browser.');
		socket.onclose = () => this.end(this.open ? 'The tab was closed.' : 'Could not reach the tab.');
	}

	/** Send a CDP call, returning its id. Dropped while the socket is not up. */
	send(method: string, params: Record<string, unknown> = {}): number {
		const id = ++this.nextId;
		if (this.open && this.socket) this.socket.send(JSON.stringify({ id, method, params }));
		return id;
	}

	/** A CDP call's result, or null when it failed, timed out or the socket went. */
	private request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
		return new Promise((resolve) => {
			const id = this.send(method, params);
			const timer = setTimeout(() => settle(null), REQUEST_TIMEOUT_MS);
			const settle = (result: Record<string, unknown> | null) => {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve(result);
			};
			this.pending.set(id, settle);
		});
	}

	private onCdp(text: string): void {
		let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof msg.id === 'number') {
			this.pending.get(msg.id)?.(msg.result ?? null);
			return;
		}
		const params = msg.params ?? {};
		switch (msg.method) {
			case 'Page.screencastFrame': {
				const meta = (params.metadata ?? {}) as Record<string, unknown>;
				// The ack is what asks for the next frame, so holding it paces the stream.
				const wait = Math.max(0, this.lastFrameAt + MIN_FRAME_MS - Date.now());
				// Only the id is kept for the timer, not the frame it came with.
				const { sessionId } = params;
				setTimeout(() => this.send('Page.screencastFrameAck', { sessionId }), wait);
				this.gotScreencast = true;
				this.visible = true;
				if (typeof params.data === 'string' && num(meta.deviceWidth) && num(meta.deviceHeight)) {
					this.frame(params.data, meta.deviceWidth, meta.deviceHeight);
				}
				break;
			}
			case 'Page.screencastVisibilityChanged':
				this.visible = params.visible !== false;
				break;
			case 'Page.frameNavigated': {
				const frame = (params.frame ?? {}) as Record<string, unknown>;
				if (!frame.parentId && typeof frame.url === 'string') this.broadcast({ type: 'nav', url: frame.url });
				break;
			}
			case 'Page.navigatedWithinDocument':
				// A page target's main frame carries the target's own id.
				if (params.frameId === this.tabId && typeof params.url === 'string') {
					this.broadcast({ type: 'nav', url: params.url });
				}
				break;
			case 'Inspector.detached':
				this.end('The tab was closed.');
				break;
		}
	}

	/**
	 * A tab in a minimised or hidden window may deliver no screencast frames at
	 * all. While it says it is not visible, or has said nothing since the
	 * screencast started, screenshots draw it instead.
	 */
	private checkStall(): void {
		const silent = !this.gotScreencast && Date.now() - this.startedAt > STALL_MS;
		if (this.open && (silent || !this.visible)) void this.shoot();
	}

	private async shoot(): Promise<void> {
		if (this.shooting) return;
		this.shooting = true;
		try {
			const [shot, metrics] = await Promise.all([
				this.request('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY }),
				this.request('Page.getLayoutMetrics')
			]);
			const viewport = (metrics?.cssVisualViewport ?? {}) as Record<string, unknown>;
			const data = shot?.data;
			if (typeof data !== 'string' || data === this.lastShot) return;
			if (!num(viewport.clientWidth) || !num(viewport.clientHeight)) return;
			this.lastShot = data;
			this.frame(data, viewport.clientWidth, viewport.clientHeight);
		} finally {
			this.shooting = false;
		}
	}

	private frame(data: string, width: number, height: number): void {
		this.lastFrameAt = Date.now();
		this.lastFrame = JSON.stringify({ type: 'frame', data, width, height } satisfies BrowserWsMessage);
		for (const viewer of this.viewers) {
			if ((viewer.getBufferedAmount?.() ?? 0) > MAX_BUFFERED) continue;
			sendTo(viewer, this.lastFrame, true);
		}
	}

	private broadcast(msg: BrowserWsMessage): void {
		const text = JSON.stringify(msg);
		for (const viewer of this.viewers) sendTo(viewer, text);
	}

	add(viewer: WsClient): void {
		this.viewers.add(viewer);
		if (this.lastFrame) sendTo(viewer, this.lastFrame, true);
	}

	/** Drop a viewer; the last one out stops the screencast and closes the CDP socket. */
	remove(viewer: WsClient): void {
		this.viewers.delete(viewer);
		if (this.viewers.size === 0) this.end(null);
	}

	/** Tear everything down. With a `reason`, the viewers are told and closed too. */
	private end(reason: string | null): void {
		if (this.ended) return;
		this.ended = true;
		if (this.shotTimer) clearInterval(this.shotTimer);
		for (const settle of [...this.pending.values()]) settle(null);
		if (reason) {
			this.broadcast({ type: 'closed', reason });
			for (const viewer of this.viewers) viewer.close();
		}
		this.viewers.clear();
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onmessage = socket.onclose = socket.onerror = null;
			try {
				if (this.open) socket.send(JSON.stringify({ id: ++this.nextId, method: 'Page.stopScreencast' }));
				socket.close();
			} catch {
				// already gone
			}
		}
		this.open = false;
		this.onEnd();
	}
}

/** Send to a viewer who is still there. A frame is a JPEG already, so it skips the socket's compression. */
function sendTo(viewer: WsClient, text: string, frame = false): void {
	try {
		if (!viewer.isOpen()) return;
		if (frame && viewer.sendUncompressed) viewer.sendUncompressed(text);
		else viewer.send(text);
	} catch {
		// the close handler removes it
	}
}

/** The viewers of each tab. A tab's CDP connection opens with its first viewer and closes with its last. */
export class BrowserWsManager {
	private readonly streams = new Map<string, TabStream>();
	private readonly deps: Required<BrowserWsDeps>;

	constructor(deps: BrowserWsDeps = {}) {
		this.deps = {
			connect: deps.connect ?? ((url) => new WebSocket(url) as unknown as CdpSocket),
			endpoint: deps.endpoint ?? browserEndpoint
		};
	}

	getStats(): { tabs: number; viewers: number } {
		let viewers = 0;
		for (const s of this.streams.values()) viewers += s.viewers.size;
		return { tabs: this.streams.size, viewers };
	}

	/**
	 * Add a viewer of `tabId`. A viewer turned away is told why first, so its
	 * pane shows that instead of connecting again for ever.
	 */
	addClient(client: WsClient, tabId: string): boolean {
		const refuse = (reason: string) => {
			sendTo(client, JSON.stringify({ type: 'closed', reason } satisfies BrowserWsMessage));
			return false;
		};
		if (!isTabId(tabId)) return refuse('That is not a tab.');
		let stream = this.streams.get(tabId);
		if (stream ? stream.viewers.size >= MAX_VIEWERS_PER_TAB : this.streams.size >= MAX_TABS) {
			return refuse('Too many browser views are open. Close one and try again.');
		}
		if (!stream) {
			const made: TabStream = new TabStream(tabId, this.deps, () => {
				if (this.streams.get(tabId) === made) this.streams.delete(tabId);
			});
			stream = made;
			this.streams.set(tabId, stream);
		}
		stream.add(client);
		return true;
	}

	removeClient(client: WsClient, tabId?: string): void {
		if (tabId) this.streams.get(tabId)?.remove(client);
	}

	/** A viewer's message: input for the tab it is watching, and nothing else. */
	handleMessage(client: WsClient, tabId: string, text: string): void {
		const stream = this.streams.get(tabId);
		if (!stream?.viewers.has(client)) return;
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		const call = toCdpInput(msg);
		if (call) stream.send(call.method, call.params);
	}
}

// ── who may connect ─────────────────────────────────────────────────────

/**
 * Whether a WebSocket upgrade may open the browser stream. A WebSocket is not
 * held to CORS, so without this any site open in a browser on the tailnet
 * could connect and drive the person's logged-in browser. Only the page this
 * server itself served may: the pane never reads another machine's browser,
 * so not even the tailnet origins the API trusts are let in. A request with
 * no Origin did not come from a page.
 */
export const browserOriginAllowed = relayOriginAllowed;
