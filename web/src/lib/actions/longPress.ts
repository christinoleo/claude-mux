export interface LongPressOptions {
	ms?: number;
	onTrigger: () => void;
	/**
	 * The press that triggered has ended. For a hold that shows something for
	 * as long as it is held — a tooltip, a preview — rather than one that
	 * hands over to a menu outliving the finger.
	 */
	onRelease?: () => void;
	enabled?: () => boolean;
}

export interface LongPressAction {
	destroy(): void;
	update(opts: LongPressOptions): void;
}

export function longPress(node: HTMLElement, options: LongPressOptions): LongPressAction {
	let opts = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let triggered = false;

	function clear(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function start(): void {
		if (opts.enabled && !opts.enabled()) return;
		triggered = false;
		clear();
		timer = setTimeout(() => {
			timer = null;
			triggered = true;
			opts.onTrigger();
		}, opts.ms ?? 500);
	}

	/**
	 * End the press. `triggered` stays set, because the click that follows a
	 * mouse hold still has to be swallowed by the capture handler.
	 */
	function release(): void {
		const held = triggered;
		clear();
		if (held) opts.onRelease?.();
	}

	function onMouseDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		start();
	}

	function onTouchStart(): void {
		start();
	}

	function onTouchEnd(e: TouchEvent): void {
		release();
		if (triggered) {
			e.preventDefault();
			triggered = false;
		}
	}

	function onClickCapture(e: MouseEvent): void {
		if (triggered) {
			e.preventDefault();
			e.stopPropagation();
			triggered = false;
		}
	}

	function onTouchCancel(): void {
		release();
		triggered = false;
	}

	node.addEventListener('mousedown', onMouseDown);
	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchmove', release);
	node.addEventListener('touchend', onTouchEnd);
	node.addEventListener('touchcancel', onTouchCancel);
	node.addEventListener('mouseup', release);
	node.addEventListener('mouseleave', release);
	node.addEventListener('click', onClickCapture, { capture: true });

	return {
		destroy(): void {
			clear();
			node.removeEventListener('mousedown', onMouseDown);
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', release);
			node.removeEventListener('touchend', onTouchEnd);
			node.removeEventListener('touchcancel', onTouchCancel);
			node.removeEventListener('mouseup', release);
			node.removeEventListener('mouseleave', release);
			node.removeEventListener('click', onClickCapture, { capture: true });
		},
		update(next: LongPressOptions): void {
			opts = next;
		}
	};
}
