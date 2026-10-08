/**
 * One wall clock for every relative time on the page, so rows that say "5m"
 * or count a turn up tick together instead of each running a timer of its
 * own. Coarse (every 30s) by default; every second while anything holds `fine()`.
 */
import { browser } from '$app/environment';

class Clock {
	now = $state(Date.now());
	#fine = 0;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		if (browser) this.#schedule();
	}

	#schedule(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = setInterval(() => (this.now = Date.now()), this.#fine > 0 ? 1000 : 30_000);
	}

	/** Tick every second until the returned release is called. */
	fine(): () => void {
		this.now = Date.now();
		if (this.#fine++ === 0) this.#schedule();
		return () => {
			if (--this.#fine === 0) this.#schedule();
		};
	}
}

export const clock = new Clock();
