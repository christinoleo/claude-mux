import { pathTo, scrollTakesIt, type Axis } from './swipe';

/**
 * Keeps a finger on an overlay from scrolling the page behind it: the phone's
 * drawer over the transcript.
 *
 * `overscroll-behavior: contain` on the drawer's lists stops only a scroll that
 * starts in one of them and runs out. A touch that starts on something that
 * cannot scroll (the header, the filter, the foot, a list shorter than the
 * drawer, the rail when its tiles fit) has no scroller to contain it, and the
 * browser hands it to the document, which on iOS moves whatever sits behind.
 * So every move is read against the way up from the finger: when nothing
 * there can scroll the way it is being dragged, the move is cancelled.
 *
 * Only native scrolling is stopped. The drawer's own touch handlers (the
 * swipe that shuts it, a tile being dragged along the rail) still see every
 * move.
 */
export interface HoldScrollOptions {
	/** Read on every move: hold only while this says the overlay is up. */
	enabled: () => boolean;
}

/** Travel, in px, before a move says which way it goes. */
const SLOP = 2;

/**
 * Must this move be stopped? `dx`/`dy` is the travel since the touch began,
 * which picks the axis; `step` the travel since the last move, which picks the
 * way along it, since a finger may turn back mid-gesture.
 */
export function holdsMove(
	path: Element[],
	dx: number,
	dy: number,
	step: { x: number; y: number }
): boolean {
	if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return false;
	const axis: Axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
	const along = axis === 'x' ? step.x : step.y;
	if (along === 0) return false;
	return !scrollTakesIt(path, axis, along > 0);
}

export function holdScroll(node: HTMLElement, options: HoldScrollOptions) {
	let opts = options;
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastY = 0;
	let path: Element[] = [];

	function onTouchStart(e: TouchEvent): void {
		const touch = e.touches[0];
		if (!touch) return;
		startX = lastX = touch.clientX;
		startY = lastY = touch.clientY;
		path = pathTo(e.target, node);
	}

	function onTouchMove(e: TouchEvent): void {
		const touch = e.touches[0];
		if (!touch || e.touches.length !== 1) return;
		const step = { x: touch.clientX - lastX, y: touch.clientY - lastY };
		lastX = touch.clientX;
		lastY = touch.clientY;
		if (!e.cancelable || !opts.enabled()) return;
		if (holdsMove(path, touch.clientX - startX, touch.clientY - startY, step)) e.preventDefault();
	}

	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchmove', onTouchMove, { passive: false });

	return {
		destroy(): void {
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', onTouchMove);
		},
		update(next: HoldScrollOptions): void {
			opts = next;
		}
	};
}
