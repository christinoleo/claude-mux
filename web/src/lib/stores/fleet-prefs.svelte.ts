/**
 * The fleet preferences (`src/fleet-prefs.ts`) as this page's origin holds
 * them: what the sidebar folds and filters, the same on every link and
 * device. They arrive on the sessions socket, which `sessionStore` hands
 * here, and a write goes to the origin, which spreads it across the fleet.
 *
 * A write shows at once; until the origin answers, its value stands over
 * whatever the socket says, so an older set arriving in between does not
 * flicker the fold back. A write the origin refuses is dropped, and the
 * origin's value shows again.
 */

import type { FleetPrefs } from '$shared/fleet-prefs.js';

class FleetPrefsStore {
	private held = $state.raw<FleetPrefs>({});
	/** Writes not yet answered, by key, each with the number of the write. */
	private pending = $state.raw<Record<string, { value: unknown; seq: number }>>({});
	private seq = 0;

	get<T>(key: string, fallback: T): T {
		if (key in this.pending) return this.pending[key].value as T;
		const entry = this.held[key];
		return entry ? (entry.value as T) : fallback;
	}

	/** The set the origin sent, whole. */
	receive(prefs: FleetPrefs): void {
		this.held = prefs;
	}

	async set(key: string, value: unknown): Promise<void> {
		const seq = ++this.seq;
		this.pending = { ...this.pending, [key]: { value, seq } };
		try {
			const res = await fetch('/api/fleet/prefs', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key, value })
			});
			if (res.ok) {
				const data = (await res.json()) as { prefs?: FleetPrefs };
				if (data.prefs) this.held = data.prefs;
			} else {
				console.warn('[fleet-prefs] write refused:', key, res.status);
			}
		} catch (err) {
			console.warn('[fleet-prefs] write failed:', key, err);
		} finally {
			// A later write to the same key keeps its own hold.
			if (this.pending[key]?.seq === seq) {
				const { [key]: _done, ...rest } = this.pending;
				this.pending = rest;
			}
		}
	}
}

export const fleetPrefsStore = new FleetPrefsStore();
