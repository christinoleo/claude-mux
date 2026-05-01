export interface LongPressOptions {
	ms?: number;
	onTrigger: () => void;
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

	function onMouseDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		start();
	}

	function onTouchStart(): void {
		start();
	}

	function onTouchEnd(e: TouchEvent): void {
		clear();
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

	node.addEventListener('mousedown', onMouseDown);
	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchmove', clear);
	node.addEventListener('touchend', onTouchEnd);
	node.addEventListener('mouseup', clear);
	node.addEventListener('mouseleave', clear);
	node.addEventListener('click', onClickCapture, { capture: true });

	return {
		destroy(): void {
			clear();
			node.removeEventListener('mousedown', onMouseDown);
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', clear);
			node.removeEventListener('touchend', onTouchEnd);
			node.removeEventListener('mouseup', clear);
			node.removeEventListener('mouseleave', clear);
			node.removeEventListener('click', onClickCapture, { capture: true });
		},
		update(next: LongPressOptions): void {
			opts = next;
		}
	};
}
