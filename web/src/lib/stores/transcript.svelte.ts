import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';
import type { ContextUsage } from '../../../../src/transcript/context.js';
import type { TranscriptEntry } from '../../../../src/transcript/parser.js';
import type { SubagentPayload } from '../../../../src/server/ws-handlers.js';

export type { SubagentPayload };

interface SnapshotMsg {
	type: 'snapshot';
	entries: TranscriptEntry[];
	firstIndex: number;
	subagents: SubagentPayload[];
	context: ContextUsage | null;
	model?: string | null;
	available: boolean;
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
}
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
type TranscriptMsg = SnapshotMsg | HistoryMsg | EntriesMsg | SubagentsMsg | ContextMsg | ModelMsg;

/** Entries per "load earlier" request. */
const HISTORY_PAGE = 200;

/**
 * Transcript view model: an ordered list of entries upserted by id.
 * The server sends a full snapshot on attach and per-entry deltas afterwards
 * (an updated entry — e.g. a tool call receiving its result — keeps its
 * position; a new one is appended).
 */
class TranscriptStore extends ReliableWebSocket {
	entries = $state<TranscriptEntry[]>([]);
	/** All subagents, keyed by their own id — some have no parent Task id. */
	subagents = $state<Record<string, SubagentPayload>>({});
	/** Subagents working right now, newest last. */
	running: SubagentPayload[] = $derived(
		Object.values(this.subagents).filter((sub) => sub.running)
	);
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
	/** A history request is in flight (the button waits rather than stacking). */
	loadingEarlier = $state(false);
	/** Resolved when the slice a `loadEarlier()` caller asked for has landed. */
	private pendingEarlier: (() => void) | null = null;

	private indexById = new Map<string, number>();
	private sessionId: string | null = null;

	protected getWsUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const encoded = encodeURIComponent(this.sessionId!);
		return `${protocol}//${window.location.host}/api/sessions/${encoded}/transcript/stream`;
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
		this.settleEarlier();
	}

	/** Ends the wait a `loadEarlier()` caller is in, whatever answered it. */
	private settleEarlier(): void {
		this.loadingEarlier = false;
		this.pendingEarlier?.();
		this.pendingEarlier = null;
	}

	private reindex(): void {
		this.indexById = new Map(this.entries.map((entry, i) => [entry.id, i]));
	}

	/**
	 * Ask the server for the slice before the oldest entry held. Resolves once
	 * those entries are in `entries`, so a caller holding the reader's scroll
	 * position knows when to restore it. Resolves immediately when there is
	 * nothing older or a request is already out.
	 */
	loadEarlier(): Promise<void> {
		if (this.firstIndex <= 0 || this.loadingEarlier) return Promise.resolve();
		const sent = this.send(
			JSON.stringify({
				type: 'history_request',
				before: this.firstIndex,
				count: HISTORY_PAGE
			})
		);
		if (!sent) return Promise.resolve();
		this.loadingEarlier = true;
		return new Promise((resolve) => {
			this.pendingEarlier = resolve;
		});
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
			this.appended++;
		}
	}

	/**
	 * Single entry point: pass a claude-mux session id to view its transcript,
	 * or null to detach. Mirrors terminalStore.setTarget's lifecycle contract.
	 */
	setSession(sessionId: string | null | undefined): void {
		if (!browser) return;
		const next = sessionId ?? null;

		if (this.sessionId === next) {
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
		this.subagents = {};
		this.context = null;
		this.available = false;
		this.appended = 0;
		this.firstIndex = 0;
		this.settleEarlier();
		this.resetReceived();
		this.indexById = new Map();
		this.sessionId = next;

		if (next) this.doConnect();
	}
}

export const transcriptStore = new TranscriptStore();
