export interface ClickOutsideOptions {
	onOutside: () => void;
	enabled?: () => boolean;
}

export interface ClickOutsideAction {
	destroy(): void;
	update(opts: ClickOutsideOptions): void;
}

const ATTACH_DELAY_MS = 10;

export function clickOutside(node: HTMLElement, options: ClickOutsideOptions): ClickOutsideAction {
	let opts = options;
	let attached = false;
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;

	function onDocumentEvent(e: Event): void {
		if (!node.contains(e.target as Node)) {
			opts.onOutside();
		}
	}

	function detach(): void {
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
		if (attached) {
			document.removeEventListener('click', onDocumentEvent);
			document.removeEventListener('contextmenu', onDocumentEvent);
			attached = false;
		}
	}

	function sync(): void {
		const wantAttached = opts.enabled ? opts.enabled() : true;
		if (wantAttached && !attached && !pendingTimer) {
			pendingTimer = setTimeout(() => {
				pendingTimer = null;
				document.addEventListener('click', onDocumentEvent);
				document.addEventListener('contextmenu', onDocumentEvent);
				attached = true;
			}, ATTACH_DELAY_MS);
		} else if (!wantAttached) {
			detach();
		}
	}

	sync();

	return {
		destroy(): void {
			detach();
		},
		update(next: ClickOutsideOptions): void {
			opts = next;
			sync();
		}
	};
}
