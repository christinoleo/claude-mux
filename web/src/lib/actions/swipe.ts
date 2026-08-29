/**
 * A directional swipe, for the gestures a phone expects a full-screen app to
 * answer to: the composer's tray pulled up from the field and pushed back
 * down, the drawer pulled in from the transcript, the view thrown aside.
 *
 * Hand-rolled rather than pulled from a gesture library, for the same reason
 * `longPress` is: the hard part here is not measuring the drag, it is the two
 * things that follow. A swipe that starts on a button ends on it too, and the
 * click that follows has to be swallowed or the tray sends the key you swiped
 * off. And a swipe that starts on something which scrolls in the same
 * direction is not a swipe at all — it is a scroll, and it belongs to the
 * element under the finger.
 */
export interface SwipeOptions {
	onUp?: () => void;
	onDown?: () => void;
	onLeft?: () => void;
	onRight?: () => void;
	/** Runs before every gesture — where the caller wants touch screens only. */
	enabled?: () => boolean;
	/** Travel, in px, before a drag counts. Horizontal surfaces want more. */
	threshold?: number;
}

export interface SwipeAction {
	destroy(): void;
	update(opts: SwipeOptions): void;
}

/** Past this the finger was resting, not swiping. */
const MAX_MS = 700;
/** How far the gesture must lean into its axis to be read as that axis. */
const AXIS_RATIO = 1.7;
/** iOS owns the screen's own edges: back, and the app switcher. */
const EDGE = 24;
/** How long after a swipe a click still belongs to it. */
const CLICK_WINDOW = 500;

/** Can this element scroll under the finger, along the axis being swiped? */
function scrollsAlong(el: Element, axis: 'x' | 'y'): boolean {
	const style = getComputedStyle(el);
	const overflow = axis === 'x' ? style.overflowX : style.overflowY;
	if (overflow !== 'auto' && overflow !== 'scroll') return false;
	return axis === 'x'
		? el.scrollWidth > el.clientWidth + 2
		: el.scrollHeight > el.clientHeight + 2;
}

/** Does anything between the finger and the node want this gesture instead? */
function scrollTakesIt(from: EventTarget | null, node: HTMLElement, axis: 'x' | 'y'): boolean {
	let el = from instanceof Element ? from : null;
	while (el) {
		// A textarea scrolls its own text without saying so in `overflow`.
		if (axis === 'y' && el instanceof HTMLTextAreaElement && el.scrollHeight > el.clientHeight + 2)
			return true;
		if (scrollsAlong(el, axis)) return true;
		if (el === node) return false;
		el = el.parentElement;
	}
	return false;
}

export function swipe(node: HTMLElement, options: SwipeOptions): SwipeAction {
	let opts = options;
	let startX = 0;
	let startY = 0;
	let startAt = 0;
	let from: EventTarget | null = null;
	let tracking = false;
	/** When a gesture was last read, so the tap ending it is not a tap. */
	let swipedAt = 0;

	function onTouchStart(e: TouchEvent): void {
		tracking = false;
		if (e.touches.length !== 1) return;
		if (opts.enabled && !opts.enabled()) return;
		const touch = e.touches[0];
		if (touch.clientX < EDGE || touch.clientX > window.innerWidth - EDGE) return;
		startX = touch.clientX;
		startY = touch.clientY;
		startAt = Date.now();
		from = e.target;
		tracking = true;
	}

	function onTouchEnd(e: TouchEvent): void {
		if (!tracking) return;
		tracking = false;
		const touch = e.changedTouches[0];
		if (!touch || Date.now() - startAt > MAX_MS) return;

		const dx = touch.clientX - startX;
		const dy = touch.clientY - startY;
		const threshold = opts.threshold ?? 48;
		const axis: 'x' | 'y' | null =
			Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO
				? 'x'
				: Math.abs(dy) >= threshold && Math.abs(dy) > Math.abs(dx) * AXIS_RATIO
					? 'y'
					: null;
		if (!axis) return;

		const run =
			axis === 'x' ? (dx > 0 ? opts.onRight : opts.onLeft) : dy > 0 ? opts.onDown : opts.onUp;
		if (!run) return;
		if (scrollTakesIt(from, node, axis)) return;

		swipedAt = Date.now();
		run();
	}

	function onTouchCancel(): void {
		tracking = false;
	}

	/**
	 * The click the finger leaves behind on whatever it started from. Swallowed
	 * in the capture phase, before the button under it hears about it. Read as
	 * a window rather than a flag: a swipe over bare card leaves no click at
	 * all, and a flag left standing would eat the next real tap.
	 */
	function onClickCapture(e: MouseEvent): void {
		if (Date.now() - swipedAt > CLICK_WINDOW) return;
		swipedAt = 0;
		e.preventDefault();
		e.stopPropagation();
	}

	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchend', onTouchEnd, { passive: true });
	node.addEventListener('touchcancel', onTouchCancel, { passive: true });
	node.addEventListener('click', onClickCapture, { capture: true });

	return {
		destroy(): void {
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchend', onTouchEnd);
			node.removeEventListener('touchcancel', onTouchCancel);
			node.removeEventListener('click', onClickCapture, { capture: true });
		},
		update(next: SwipeOptions): void {
			opts = next;
		}
	};
}
