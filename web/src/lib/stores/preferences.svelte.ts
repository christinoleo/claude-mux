import { browser } from '$app/environment';

const STORAGE_KEY = 'claude-mux-preferences';

interface Preferences {
	terminalTheming: boolean;
}

const defaults: Preferences = {
	terminalTheming: true
};

function loadPreferences(): Preferences {
	if (!browser) return defaults;
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return { ...defaults, ...JSON.parse(stored) };
		}
	} catch {
		// Ignore parse errors
	}
	return defaults;
}

function savePreferences(prefs: Preferences): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Ignore storage errors
	}
}

class PreferencesStore {
	private prefs = $state<Preferences>(loadPreferences());

	get terminalTheming(): boolean {
		return this.prefs.terminalTheming;
	}

	set terminalTheming(value: boolean) {
		this.prefs.terminalTheming = value;
		savePreferences(this.prefs);
	}

	toggle(key: keyof Preferences): void {
		if (typeof this.prefs[key] === 'boolean') {
			(this.prefs[key] as boolean) = !this.prefs[key];
			savePreferences(this.prefs);
		}
	}
}

export const preferences = new PreferencesStore();
