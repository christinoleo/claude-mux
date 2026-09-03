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

/**
 * A press that has moved this far is a drag, not a hold. Wide enough to let a
 * hand rest, narrow enough that the browser has not yet started a native drag
 * (which it does after a few pixels on a `draggable` element).
 */
const MOVE_TOLERANCE_PX = 6;

/**
 * A long press is a hold that stays put. Moving ends it, and so does the
 * browser starting a drag from the same element: on a `draggable` row the
 * mouse events stop arriving once the drag is under way, so without watching
 * `dragstart` the timer would fire mid-drag and open whatever the hold opens
 * on top of the drop. The other way round, a hold that has already triggered
 * refuses the drag that a finger sliding off it would otherwise begin.
 */
export function longPress(node: HTMLElement, options: LongPressOptions): LongPressAction {
	let opts = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let triggered = false;
	let originX = 0;
	let originY = 0;

	function clear(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function start(x: number, y: number): void {
		if (opts.enabled && !opts.enabled()) return;
		triggered = false;
		originX = x;
		originY = y;
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

	function moved(x: number, y: number): boolean {
		return Math.abs(x - originX) > MOVE_TOLERANCE_PX || Math.abs(y - originY) > MOVE_TOLERANCE_PX;
	}

	function onMouseDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		start(e.clientX, e.clientY);
	}

	function onMouseMove(e: MouseEvent): void {
		if (timer && moved(e.clientX, e.clientY)) clear();
	}

	function onTouchStart(e: TouchEvent): void {
		const t = e.touches[0];
		start(t?.clientX ?? 0, t?.clientY ?? 0);
	}

	function onTouchMove(e: TouchEvent): void {
		const t = e.touches[0];
		if (timer && t && moved(t.clientX, t.clientY)) clear();
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

	function onDragStart(e: DragEvent): void {
		if (triggered) {
			// The hold already handed over to its menu; the drag is not wanted.
			e.preventDefault();
			return;
		}
		clear();
	}

	node.addEventListener('mousedown', onMouseDown);
	node.addEventListener('mousemove', onMouseMove);
	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchmove', onTouchMove, { passive: true });
	node.addEventListener('touchend', onTouchEnd);
	node.addEventListener('touchcancel', onTouchCancel);
	node.addEventListener('mouseup', release);
	node.addEventListener('mouseleave', release);
	node.addEventListener('dragstart', onDragStart);
	node.addEventListener('click', onClickCapture, { capture: true });

	return {
		destroy(): void {
			clear();
			node.removeEventListener('mousedown', onMouseDown);
			node.removeEventListener('mousemove', onMouseMove);
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', onTouchMove);
			node.removeEventListener('touchend', onTouchEnd);
			node.removeEventListener('touchcancel', onTouchCancel);
			node.removeEventListener('mouseup', release);
			node.removeEventListener('mouseleave', release);
			node.removeEventListener('dragstart', onDragStart);
			node.removeEventListener('click', onClickCapture, { capture: true });
		},
		update(next: LongPressOptions): void {
			opts = next;
		}
	};
}
