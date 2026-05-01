import { createPersisted } from './persisted';

interface Preferences {
	terminalTheming: boolean;
}

const persisted = createPersisted<Preferences>('claude-mux-preferences', {
	terminalTheming: true
});

class PreferencesStore {
	private prefs = $state<Preferences>(persisted.load());

	get terminalTheming(): boolean {
		return this.prefs.terminalTheming;
	}

	set terminalTheming(value: boolean) {
		if (this.prefs.terminalTheming === value) return;
		this.prefs.terminalTheming = value;
		persisted.save(this.prefs);
	}

	toggle(key: keyof Preferences): void {
		if (typeof this.prefs[key] === 'boolean') {
			(this.prefs[key] as boolean) = !this.prefs[key];
			persisted.save(this.prefs);
		}
	}
}

export const preferences = new PreferencesStore();
