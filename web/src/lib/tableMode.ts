import { createPersisted } from '$lib/stores/persisted';

type TableMode = 'table' | 'cards';

const KEY = 'claude-mux-table-mode';
const persisted = createPersisted<TableMode | null>(KEY, null);

function apply(mode: TableMode | null): void {
	if (mode) document.documentElement.dataset.tableMode = mode;
	else delete document.documentElement.dataset.tableMode;
}

/**
 * What the table buttons answer to: one choice for every table on this device,
 * held as an attribute on the page for CSS to read, so that a table rendered a
 * moment later (a message still arriving) is already in the right mode. With no
 * choice yet there is no attribute, and each table goes by the width it has.
 * Tables arrive as HTML, so one listener serves all their buttons.
 */
export function watchTableMode(): () => void {
	apply(persisted.load());

	function onClick(e: MouseEvent): void {
		const button = e.target instanceof Element ? e.target.closest('.md-table-toggle') : null;
		if (!button) return;
		// The label showing says what the button offers, whichever way the table got here.
		const offer = button.querySelector('.to-cards');
		const mode: TableMode = offer && getComputedStyle(offer).display !== 'none' ? 'cards' : 'table';
		persisted.save(mode);
		apply(mode);
		// Tables above it have just changed height.
		button.scrollIntoView({ block: 'nearest' });
	}

	// A split's panes are frames: the other pane hears of the choice through storage.
	function onStorage(e: StorageEvent): void {
		if (e.key === KEY || e.key === null) apply(persisted.load());
	}

	document.addEventListener('click', onClick);
	window.addEventListener('storage', onStorage);
	return () => {
		document.removeEventListener('click', onClick);
		window.removeEventListener('storage', onStorage);
	};
}
