import { createPersisted } from './persisted';
import type { NotificationMode } from '$shared/session-notifications.js';

interface Preferences {
	terminalTheming: boolean;
	keepAwake: boolean;
	/** How this browser alerts when a session needs someone or finishes a turn. */
	notificationMode: NotificationMode;
	/** A toast inside the page for the same events, while it has focus. */
	inAppToasts: boolean;
}

const persisted = createPersisted<Preferences>('claude-mux-preferences', {
	terminalTheming: true,
	keepAwake: false,
	notificationMode: 'off',
	inAppToasts: true
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

	get keepAwake(): boolean {
		return this.prefs.keepAwake;
	}

	set keepAwake(value: boolean) {
		if (this.prefs.keepAwake === value) return;
		this.prefs.keepAwake = value;
		persisted.save(this.prefs);
	}

	get notificationMode(): NotificationMode {
		return this.prefs.notificationMode;
	}

	set notificationMode(value: NotificationMode) {
		if (this.prefs.notificationMode === value) return;
		this.prefs.notificationMode = value;
		persisted.save(this.prefs);
	}

	get inAppToasts(): boolean {
		return this.prefs.inAppToasts;
	}

	set inAppToasts(value: boolean) {
		if (this.prefs.inAppToasts === value) return;
		this.prefs.inAppToasts = value;
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
