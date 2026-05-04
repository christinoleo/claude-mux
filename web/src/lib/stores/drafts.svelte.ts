import { createPersisted } from './persisted';

const PREVIEW_LEN = 32;
const SAVE_DEBOUNCE_MS = 250;
const persisted = createPersisted<Record<string, string>>('claude-mux-drafts', {});

class DraftsStore {
	private state = $state<Record<string, string>>(persisted.load());
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	get(target: string | null): string {
		if (!target) return '';
		return this.state[target] ?? '';
	}

	set(target: string | null, text: string): void {
		if (!target) return;
		const cur = this.state[target] ?? '';
		if (text === cur) return;
		if (text === '') delete this.state[target];
		else this.state[target] = text;
		this.scheduleFlush();
	}

	has(target: string | null): boolean {
		return !!target && (this.state[target]?.length ?? 0) > 0;
	}

	preview(target: string | null): string {
		const text = this.get(target);
		if (!text) return '';
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length > PREVIEW_LEN ? flat.slice(0, PREVIEW_LEN - 1) + '…' : flat;
	}

	// Coalesce keystrokes: localStorage writes serialize the whole map, so per-key
	// JSON.stringify is wasteful when the user is typing quickly.
	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			persisted.save(this.state);
		}, SAVE_DEBOUNCE_MS);
	}
}

export const draftsStore = new DraftsStore();
