export const APP_MARKER = 'claude-mux';
export const STORAGE_KEYS = {
	lastSession: 'claude-mux-last-session',
	servers: 'claude-mux-servers',
	sidebarWidth: 'claude-mux-sidebar-width'
} as const;

/** Apple keyboards say ⌘ where everyone else says Ctrl. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = IS_MAC ? '\u2318' : 'Ctrl';

/**
 * The two ways to put a message into a running turn, as every surface that
 * offers them names them: the composer, the recording bar and a queued item.
 */
export const STEERS = {
	steer: {
		label: 'Steer',
		icon: 'mdi:arrow-right-top',
		title: 'Steer: Claude reads it when it next stops for input'
	},
	now: { label: 'Now', icon: 'mdi:lightning-bolt', title: 'Now: make Claude read it right away' }
} as const;
export type SteerMode = keyof typeof STEERS;
