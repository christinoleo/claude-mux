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

type Axis = 'x' | 'y';

/**
 * Can this element scroll under the finger, along the axis and the way it is
 * being dragged? `forward` is a drag toward the start (right, or down), which
 * scrolls content back. Three things have to hold, and each one alone used to
 * swallow the drawer's swipe. `overflow` says the element may scroll, but one
 * that scrolls down computes `auto` across as well, so a transcript with one
 * wide line in it claimed every sideways gesture. `touch-action` says whether
 * a finger is allowed to. And there has to be somewhere left to go: a code
 * block resting at its left end has nothing to give a drag to the right.
 */
function scrollsAlong(el: Element, axis: Axis, forward: boolean): boolean {
	const style = getComputedStyle(el);
	const overflow = axis === 'x' ? style.overflowX : style.overflowY;
	if (overflow !== 'auto' && overflow !== 'scroll') return false;
	const touch = style.touchAction;
	if (touch === 'none' || touch === (axis === 'x' ? 'pan-y' : 'pan-x')) return false;
	const at = axis === 'x' ? el.scrollLeft : el.scrollTop;
	const max = axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
	return forward ? at > 2 : at < max - 2;
}

/** Does anything between the finger and the node want this gesture instead? */
function scrollTakesIt(path: Element[], axis: Axis, forward: boolean): boolean {
	return path.some(
		(el) =>
			// A textarea scrolls its own text without saying so in `overflow`.
			(axis === 'y' && el instanceof HTMLTextAreaElement && el.scrollHeight > el.clientHeight + 2) ||
			scrollsAlong(el, axis, forward)
	);
}

/** The finger's element and everything above it, up to and including the node. */
function pathTo(from: EventTarget | null, node: HTMLElement): Element[] {
	const path: Element[] = [];
	for (let el = from instanceof Element ? from : null; el; el = el.parentElement) {
		path.push(el);
		if (el === node) break;
	}
	return path;
}

export function swipe(node: HTMLElement, options: SwipeOptions): SwipeAction {
	let opts = options;
	let startX = 0;
	let startY = 0;
	let startAt = 0;
	/**
	 * Where the finger came down, and the way up from there, read at once. A
	 * touch keeps reporting to the element it started on even after that
	 * element has left the page, and a live pane redraws its lines twice a
	 * second: the `touchend` then never bubbles to the node, so the gesture has
	 * to listen on the element itself, and cannot walk its parents afterwards.
	 */
	let from: EventTarget | null = null;
	let path: Element[] = [];
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
		release();
		from = e.target;
		path = pathTo(from, node);
		from?.addEventListener('touchend', onTouchEnd as EventListener, { passive: true });
		from?.addEventListener('touchcancel', onTouchCancel, { passive: true });
		tracking = true;
	}

	function release(): void {
		from?.removeEventListener('touchend', onTouchEnd as EventListener);
		from?.removeEventListener('touchcancel', onTouchCancel);
		from = null;
	}

	function onTouchEnd(e: TouchEvent): void {
		release();
		if (!tracking) return;
		tracking = false;
		const touch = e.changedTouches[0];
		if (!touch || Date.now() - startAt > MAX_MS) return;

		const dx = touch.clientX - startX;
		const dy = touch.clientY - startY;
		const threshold = opts.threshold ?? 48;
		const axis: Axis | null =
			Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO
				? 'x'
				: Math.abs(dy) >= threshold && Math.abs(dy) > Math.abs(dx) * AXIS_RATIO
					? 'y'
					: null;
		if (!axis) return;

		const run =
			axis === 'x' ? (dx > 0 ? opts.onRight : opts.onLeft) : dy > 0 ? opts.onDown : opts.onUp;
		if (!run) return;
		if (scrollTakesIt(path, axis, (axis === 'x' ? dx : dy) > 0)) return;

		swipedAt = Date.now();
		run();
	}

	function onTouchCancel(): void {
		release();
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
			release();
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
