import { browser } from '$app/environment';
import { hostTimeZone, makeDayFormatter } from '$lib/format';
import type { QuotaResult, UsageResponse } from '$lib/types/usage';

const REFRESH_MS = 5 * 60 * 1000;

/**
 * Plan limits and spend, polled once for the whole page.
 *
 * Subscribers are counted so the poll belongs to the store rather than to
 * whichever component happened to mount first: any number of readers share one
 * pair of requests, and the timer stops when the last of them goes away.
 */
class UsageStore {
	summary = $state<UsageResponse | null>(null);
	quota = $state<QuotaResult | null>(null);

	private subscribers = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly zone = hostTimeZone();
	private readonly dayOf = makeDayFormatter(hostTimeZone());

	/**
	 * Today's spend, looked up by the host's own day boundary — the last row of
	 * `days` is only today if today has spend on it.
	 */
	get today(): number | null {
		if (!this.summary) return null;
		const key = this.dayOf(Date.now());
		return this.summary.days.find((d) => d.date === key)?.costUsd ?? 0;
	}

	/** Returns the matching stop, for an effect's cleanup. */
	subscribe(): () => void {
		if (!browser) return () => {};
		this.subscribers++;
		if (this.subscribers === 1) {
			void this.load();
			this.timer = setInterval(() => void this.load(), REFRESH_MS);
		}
		return () => {
			this.subscribers--;
			if (this.subscribers === 0 && this.timer !== null) {
				clearInterval(this.timer);
				this.timer = null;
			}
		};
	}

	private async load(): Promise<void> {
		await Promise.all([this.loadSummary(), this.loadQuota()]);
	}

	private async loadSummary(): Promise<void> {
		try {
			const res = await fetch(`/api/usage?days=30&tz=${encodeURIComponent(this.zone)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.summary = (await res.json()) as UsageResponse;
		} catch {
			// The last good numbers stay put rather than blanking the meters.
		}
	}

	private async loadQuota(): Promise<void> {
		try {
			const res = await fetch('/api/usage/quota');
			if (res.ok) this.quota = (await res.json()) as QuotaResult;
		} catch {
			// The cost figures still stand without it.
		}
	}
}

export const usageStore = new UsageStore();
