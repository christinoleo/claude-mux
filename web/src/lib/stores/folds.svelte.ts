/**
 * The sidebar's folds for this visit: kept by the module, so the drawer
 * closing and opening again on a phone keeps them, and gone on reload.
 */
import { isOpen } from '$shared/sidebar-folds.js';

class Folds {
	/** Written key by key, so a tap redraws only the rows that read that key. */
	#choices = $state<Record<string, boolean>>({});

	isOpen(key: string, byDefault: boolean): boolean {
		return isOpen(this.#choices, key, byDefault);
	}

	toggle(key: string, byDefault: boolean): void {
		this.#choices[key] = !isOpen(this.#choices, key, byDefault);
	}
}

export const folds = new Folds();
