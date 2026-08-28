/**
 * Display formatting shared by the usage page and the sidebar widget.
 */
export { makeDayFormatter, hostTimeZone } from '../../../src/usage/day.js';

/**
 * A dollar amount, with as much precision as the magnitude deserves.
 *
 * `terse` drops the cents earlier, for places like the sidebar where the
 * column is a few characters wide.
 */
export function money(value: number, terse = false): string {
	const wholeAt = terse ? 100 : 1000;
	if (value >= wholeAt) {
		return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
	}
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(3)}`;
}

/** Large counts as "2.2B", "941.5M". */
export function compact(value: number): string {
	return Intl.NumberFormat('en-US', {
		notation: 'compact',
		maximumFractionDigits: 1
	}).format(value);
}

/** Recording length as m:ss — the only clock in the app that counts up. */
export function formatElapsed(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
