/**
 * The side panel's sizes. The column sits beside the session (transcript and
 * composer) on a wide screen and becomes a sheet over it below
 * INLINE_MEDIA_QUERY's width.
 */

const REM = 16;

/** Narrower than this, the panel is a sheet rather than a column. */
export const INLINE_MEDIA_QUERY = '(min-width: 1181px)';
/** Narrower than this, the sheet takes the whole screen. */
export const PHONE_MEDIA_QUERY = '(max-width: 640px)';

/** The default width, until a drag sets one. */
export const DEFAULT_WIDTH_CSS = 'clamp(28rem, 48vw, 44rem)';
export const PANEL_MIN_PX = 26 * REM;
/** The session column — transcript and composer — is never squeezed below this. */
export const SESSION_MIN_PX = 28 * REM;
/** The divider between the two columns. */
export const DIVIDER_PX = 6;

/**
 * The width a drag to `pointerX` asks for, or null when it would squeeze the
 * session column below its minimum (the drag is then refused and the panel
 * keeps its width). Narrower than the panel's own minimum clamps to it.
 */
export function dragWidth(pointerX: number, rowRight: number, rowWidth: number): number | null {
	const width = Math.max(PANEL_MIN_PX, Math.round(rowRight - pointerX - DIVIDER_PX / 2));
	return rowWidth - width - DIVIDER_PX < SESSION_MIN_PX ? null : width;
}
