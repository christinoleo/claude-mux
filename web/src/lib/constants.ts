export const APP_MARKER = 'claude-mux';
export const STORAGE_KEYS = {
	lastSession: 'claude-mux-last-session',
	servers: 'claude-mux-servers',
	sidebarWidth: 'claude-mux-sidebar-width'
} as const;

/** Apple keyboards say ⌘ where everyone else says Ctrl. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = IS_MAC ? '\u2318' : 'Ctrl';
