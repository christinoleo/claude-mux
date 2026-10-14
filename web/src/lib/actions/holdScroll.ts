import { AXIS_RATIO, pathTo, scrollTakesIt, type Axis } from './swipe';

/**
 * Must this move be stopped? `dx`/`dy` is the travel since the touch began,
 * which picks the axis; `step` the travel since the last move, which picks the
 * way along it, since a finger may turn back mid-gesture.
 *
 * Only a move that leans well into the sideways axis is read as sideways, the
 * way `swipe` reads it: a thumb landing at a slant is scrolling the list, and
 * a first move cancelled as sideways would cost the whole drag its scroll.
 */
export function holdsMove(
	path: Element[],
	dx: number,
	dy: number,
	step: { x: number; y: number }
): boolean {
	const axis: Axis = Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? 'x' : 'y';
	const along = axis === 'x' ? step.x : step.y;
	if (along === 0) return false;
	// A row redrawn under the finger leaves a detached path that reads as
	// unscrollable; the lists' own `overscroll-behavior` covers that drag.
	if (!path[0]?.isConnected) return false;
	// A field's text moves sideways under a drag (the caret, a selection).
	if (axis === 'x' && path.some((el) => el instanceof HTMLInputElement)) return false;
	return !scrollTakesIt(path, axis, along > 0);
}

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
 *
 * The blocking `touchmove` listener is attached only while `enabled`, so the
 * sidebar scrolls off the main thread whenever nothing needs holding.
 */
export function holdScroll(node: HTMLElement, enabled: boolean) {
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastY = 0;
	let path: Element[] = [];

	function onTouchStart(e: TouchEvent): void {
		const touch = e.touches[0];
		startX = lastX = touch.clientX;
		startY = lastY = touch.clientY;
		path = pathTo(e.target, node);
	}

	function onTouchMove(e: TouchEvent): void {
		const touch = e.touches[0];
		const step = { x: touch.clientX - lastX, y: touch.clientY - lastY };
		lastX = touch.clientX;
		lastY = touch.clientY;
		if (!e.cancelable) return;
		// Two fingers pan the page behind, and nothing in the drawer wants them.
		if (e.touches.length !== 1) return e.preventDefault();
		if (holdsMove(path, touch.clientX - startX, touch.clientY - startY, step)) e.preventDefault();
	}

	function set(on: boolean): void {
		if (on) {
			node.addEventListener('touchstart', onTouchStart, { passive: true });
			node.addEventListener('touchmove', onTouchMove, { passive: false });
		} else {
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', onTouchMove);
		}
	}

	set(enabled);
	return {
		update(next: boolean): void {
			if (next !== enabled) set((enabled = next));
		},
		destroy(): void {
			set(false);
		}
	};
}
