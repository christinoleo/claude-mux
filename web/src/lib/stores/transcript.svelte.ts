import { browser } from '$app/environment';
import { ReliableWebSocket } from './websocket-base.svelte';
import type { TranscriptEntry } from '../../../../src/transcript/parser.js';
import type { SubagentPayload } from '../../../../src/server/ws-handlers.js';

export type { SubagentPayload };

interface SnapshotMsg {
	type: 'snapshot';
	entries: TranscriptEntry[];
	subagents: SubagentPayload[];
	available: boolean;
}
interface EntriesMsg {
	type: 'entries';
	entries: TranscriptEntry[];
}
interface SubagentsMsg {
	type: 'subagents';
	subagents: SubagentPayload[];
}
type TranscriptMsg = SnapshotMsg | EntriesMsg | SubagentsMsg;

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
	/** False until the session's JSONL file has been found and read. */
	available = $state(false);
	/** Entries appended since attach (page diffs it for the "new below" pill). */
	appended = $state(0);

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
			case 'entries':
				this.applyEntries(data);
				break;
			case 'subagents':
				this.applySubagents(data.subagents);
				break;
		}
	}

	private applySnapshot(msg: SnapshotMsg): void {
		this.entries = msg.entries;
		this.available = msg.available;
		this.indexById = new Map(msg.entries.map((entry, i) => [entry.id, i]));
		this.subagents = {};
		this.applySubagents(msg.subagents ?? []);
	}

	/** Subagents arrive whole (they are short). */
	private applySubagents(subagents: SubagentPayload[]): void {
		for (const sub of subagents) {
			this.subagents[sub.agentId] = sub;
		}
	}

	private applyEntries(msg: EntriesMsg): void {
		this.available = true;
		for (const entry of msg.entries) {
			const index = this.indexById.get(entry.id);
			if (index !== undefined) {
				this.entries[index] = entry;
			} else {
				this.indexById.set(entry.id, this.entries.length);
				this.entries.push(entry);
				this.appended++;
			}
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
		this.available = false;
		this.appended = 0;
		this.indexById = new Map();
		this.sessionId = next;

		if (next) this.doConnect();
	}
}

export const transcriptStore = new TranscriptStore();
