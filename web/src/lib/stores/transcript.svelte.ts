import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';
import type { ContextUsage } from '../../../../src/transcript/context.js';
import type { TranscriptEntry } from '../../../../src/transcript/parser.js';
import type { SubagentPayload, TranscriptWsMessage } from '../../../../src/server/ws-handlers.js';
import type { LiveText } from '../../../../src/transcript/live-text.js';

export type { SubagentPayload };

interface SnapshotMsg {
	type: 'snapshot';
	entries: TranscriptEntry[];
	firstIndex: number;
	subagents: SubagentPayload[];
	context: ContextUsage | null;
	model?: string | null;
	available: boolean;
	live?: LiveText[];
}
interface HistoryMsg {
	type: 'history';
	entries: TranscriptEntry[];
	firstIndex: number;
}
interface EntriesMsg {
	type: 'entries';
	entries: TranscriptEntry[];
	indices: number[];
	live?: LiveText[];
}
type LiveBatchMsg = Extract<TranscriptWsMessage, { type: 'live_batch' }>;
type LiveMsg = Extract<TranscriptWsMessage, { type: 'live' }>;
interface SubagentsMsg {
	type: 'subagents';
	subagents: SubagentPayload[];
}
interface ContextMsg {
	type: 'context';
	context: ContextUsage;
}
interface ModelMsg {
	type: 'model';
	model: string;
}
type TranscriptMsg =
	| SnapshotMsg
	| HistoryMsg
	| EntriesMsg
	| LiveBatchMsg
	| LiveMsg
	| SubagentsMsg
	| ContextMsg
	| ModelMsg;

/** Marks a drawn entry as live text, which is still only part of what it will say. */
export const LIVE_ENTRY_PREFIX = 'live:';

/** Entries per "load earlier" request. */
const HISTORY_PAGE = 200;
/** How long a history request may go unanswered before its callers stop waiting. */
const EARLIER_TIMEOUT_MS = 15_000;

/**
 * Transcript view model: an ordered list of entries upserted by id.
 * The server sends a full snapshot on attach and per-entry deltas afterwards
 * (an updated entry — e.g. a tool call receiving its result — keeps its
 * position; a new one is appended).
 */
export class TranscriptStore extends ReliableWebSocket {
	entries = $state<TranscriptEntry[]>([]);
	/** The reply being written, which the record has not taken yet. */
	live = $state<LiveText[]>([]);
	/**
	 * Entries as drawn: live text goes last, as the text entry it will become,
	 * so it renders the same and the swap to the real one moves nothing. `text`
	 * is a getter so that a batch re-renders that entry, not the whole list.
	 */
	drawn: TranscriptEntry[] = $derived(
		this.live.length === 0
			? this.entries
			: [
					...this.entries,
					...this.live.map((m) => ({
						kind: 'text' as const,
						id: `${LIVE_ENTRY_PREFIX}${m.id}`,
						ts: m.ts,
						get text() {
							return m.text;
						}
					}))
				]
	);
	/** All subagents, keyed by their own id — some have no parent Task id. */
	subagents = $state<Record<string, SubagentPayload>>({});
	/** The subset that can be attached to a Task card, keyed by that card's id. */
	subagentsByTask: Record<string, SubagentPayload> = $derived(
		Object.fromEntries(
			Object.values(this.subagents)
				.filter((sub) => sub.toolUseId)
				.map((sub) => [sub.toolUseId as string, sub])
		)
	);
	/** Context window in use as of the last API response, null before one. */
	context = $state<ContextUsage | null>(null);
	/** The model on the latest assistant line, as the API names it. */
	model = $state<string | null>(null);
	/** False until the session's JSONL file has been found and read. */
	available = $state(false);
	/** Entries appended since attach (page diffs it for the "new below" pill). */
	appended = $state(0);
	/**
	 * Position of `entries[0]` in the session's whole transcript: the server
	 * sends only the tail, so this is how many older entries exist. Zero once
	 * the reader has pulled the whole thing back.
	 */
	firstIndex = $state(0);
	/** The history request in flight, and how to end its callers' wait. */
	private earlier = $state.raw<{ promise: Promise<boolean>; settle: (landed: boolean) => void } | null>(null);
	/** A history request is in flight (the button waits rather than stacking). */
	get loadingEarlier(): boolean {
		return this.earlier !== null;
	}

	private indexById = new Map<string, number>();
	private sessionId: string | null = null;
	/** Set when this store reads one of the session's subagents instead of the session. */
	private agentId: string | null = null;
	/** The path the session's machine is reached through: '' here, `/fleet/<id>` elsewhere. */
	private base = '';
	/** What the socket reaches (`routeMachine().address`): a new base to the same address keeps it. */
	private address = '';

	protected getWsUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const session = encodeURIComponent(this.sessionId!);
		const agent = this.agentId ? `/agents/${encodeURIComponent(this.agentId)}` : '';
		return `${protocol}//${window.location.host}${this.base}/api/sessions/${session}${agent}/transcript/stream`;
	}

	protected getLogPrefix(): string {
		return '[transcript]';
	}

	protected shouldReconnect(): boolean {
		return this.sessionId !== null;
	}

	protected handleMessage(event: MessageEvent): void {
		let data: TranscriptMsg;
		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}
		switch (data.type) {
			case 'snapshot':
				this.applySnapshot(data);
				break;
			case 'history':
				this.applyHistory(data);
				break;
			case 'entries':
				this.applyEntries(data);
				break;
			case 'live_batch':
				this.applyLiveBatch(data);
				break;
			case 'live':
				this.live = data.live;
				break;
			case 'subagents':
				this.applySubagents(data.subagents);
				break;
			case 'context':
				this.context = data.context;
				break;
			case 'model':
				this.model = data.model;
				break;
		}
	}

	private applySnapshot(msg: SnapshotMsg): void {
		this.entries = msg.entries;
		this.live = msg.live ?? [];
		this.available = msg.available;
		this.firstIndex = msg.firstIndex;
		this.settleEarlier();
		this.context = msg.context ?? null;
		this.model = msg.model ?? null;
		this.reindex();
		this.subagents = {};
		this.applySubagents(msg.subagents ?? []);
	}

	/** An older slice, prepended in front of what is already held. */
	private applyHistory(msg: HistoryMsg): void {
		// A snapshot may have overtaken the request; anything already held wins.
		const older = msg.entries.filter((entry) => !this.indexById.has(entry.id));
		if (older.length > 0) {
			this.entries = [...older, ...this.entries];
			this.firstIndex = msg.firstIndex;
			this.reindex();
		}
		this.settleEarlier(older.length > 0);
	}

	/** Ends the wait a `loadEarlier()` caller is in, whatever answered it. */
	private settleEarlier(landed = false): void {
		this.earlier?.settle(landed);
		this.earlier = null;
	}

	/** A slice the socket went away before answering will not come. */
	protected onDisconnected(): void {
		this.settleEarlier();
	}

	private reindex(): void {
		this.indexById = new Map(this.entries.map((entry, i) => [entry.id, i]));
	}

	/**
	 * Ask the server for the slice before the oldest entry held. Resolves true
	 * once those entries are in `entries`, so a caller holding the reader's
	 * scroll position knows when to restore it. A second caller waits on the
	 * request already out. Resolves false when nothing landed: nothing older, no
	 * socket, or no answer in `EARLIER_TIMEOUT_MS` (the server does not answer a
	 * request it cannot serve).
	 */
	loadEarlier(): Promise<boolean> {
		if (this.earlier) return this.earlier.promise;
		if (this.firstIndex <= 0) return Promise.resolve(false);
		const sent = this.send(
			JSON.stringify({
				type: 'history_request',
				before: this.firstIndex,
				count: HISTORY_PAGE
			})
		);
		if (!sent) return Promise.resolve(false);
		let resolve!: (landed: boolean) => void;
		const promise = new Promise<boolean>((r) => (resolve = r));
		const timer = setTimeout(() => this.settleEarlier(), EARLIER_TIMEOUT_MS);
		this.earlier = {
			promise,
			settle: (landed) => {
				clearTimeout(timer);
				resolve(landed);
			}
		};
		return promise;
	}

	/**
	 * Ask for everything an agent ran and reported. Cards arrive lean — the
	 * tail of the activity, no report — and this is what opening one sends.
	 */
	loadSubagent(agentId: string): void {
		const held = this.subagents[agentId];
		if (!held || held.full) return;
		this.send(JSON.stringify({ type: 'subagent_request', agentId }));
	}

	/**
	 * Subagents arrive lean unless their card was opened. A lean update for an
	 * agent already held in full keeps what is held and appends the new tail,
	 * so an open card does not lose its list to the next live update.
	 */
	private applySubagents(subagents: SubagentPayload[]): void {
		for (const sub of subagents) {
			const held = this.subagents[sub.agentId];
			if (held?.full && !sub.full) {
				const seen = new Set(sub.activity.map((a) => a.id));
				const kept = held.activity.filter((a) => !seen.has(a.id));
				this.subagents[sub.agentId] = {
					...sub,
					activity: [...kept, ...sub.activity],
					trimmed: Math.max(0, sub.trimmed - kept.length),
					report: sub.report ?? held.report,
					full: true
				};
				continue;
			}
			this.subagents[sub.agentId] = sub;
		}
	}

	private applyEntries(msg: EntriesMsg): void {
		this.available = true;
		const drawnBefore = this.entries.length + this.live.length;
		for (const [i, entry] of msg.entries.entries()) {
			const index = this.indexById.get(entry.id);
			if (index !== undefined) {
				this.entries[index] = entry;
				continue;
			}
			// An update to an entry older than the tail this client holds: it
			// belongs in the gap above, and arrives with the history slice.
			if (msg.indices[i] < this.firstIndex) continue;
			this.indexById.set(entry.id, this.entries.length);
			this.entries.push(entry);
		}
		if (msg.live) this.live = msg.live;
		// Counted on what is drawn, since an entry replacing live text adds nothing new.
		this.appended += Math.max(0, this.entries.length + this.live.length - drawnBefore);
	}

	private applyLiveBatch(msg: LiveBatchMsg): void {
		const held = this.live.find((m) => m.id === msg.id);
		if (held) {
			held.text = held.text.slice(0, msg.start) + msg.text;
			if (held.text === '') this.live = this.live.filter((m) => m !== held);
		} else if (msg.start === 0) {
			this.live.push({ id: msg.id, ts: Date.now(), text: msg.text });
			this.appended++;
		}
	}

	/**
	 * Single entry point: pass a claude-mux session id to view its transcript,
	 * or null to detach. Mirrors terminalStore.setTarget's lifecycle contract.
	 * With `agentId`, the store holds that subagent's transcript instead, and
	 * `subagents` holds that one agent. `base` names the session's machine
	 * (`machineBase()`), and `address` what it reaches: when only the base
	 * changes (the machine's id changed), the next connect takes the new base
	 * and the open socket and its entries stay.
	 */
	setSession(sessionId: string | null | undefined, agentId: string | null = null, base = '', address = base): void {
		if (!browser) return;
		const next = sessionId ?? null;
		const nextAgent = next ? agentId : null;

		if (this.sessionId === next && this.agentId === nextAgent && this.address === address) {
			this.base = base;
			if (next === null) return;
			if (this.ws) return;
			this.doConnect();
			return;
		}

		if (this.ws) {
			this.sessionId = null; // suppress reconnect in doDisconnect
			this.doDisconnect();
		}
		this.entries = [];
		this.live = [];
		this.subagents = {};
		this.context = null;
		this.available = false;
		this.appended = 0;
		this.firstIndex = 0;
		this.settleEarlier();
		this.resetReceived();
		this.indexById = new Map();
		this.sessionId = next;
		this.agentId = nextAgent;
		this.base = base;
		this.address = address;

		if (next) this.doConnect();
	}
}

export const transcriptStore = new TranscriptStore();
