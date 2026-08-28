/**
 * The one status palette, shared by every meter in the app.
 *
 * These four steps are deliberately outside the categorical colours the usage
 * chart assigns to projects and models, so a status never impersonates a
 * series. Colour never carries the meaning alone — each step ships with an
 * icon and a word, which is what makes the scale readable without colour.
 */

export type Severity = 'normal' | 'warning' | 'critical';

export interface SeverityStyle {
	color: string;
	icon: string;
	word: string;
}

export const SEVERITY: Record<Severity, SeverityStyle> = {
	normal: { color: '#0ca30c', icon: 'mdi:check-circle-outline', word: 'ok' },
	warning: { color: '#fab219', icon: 'mdi:alert-outline', word: 'high' },
	critical: { color: '#d03b3b', icon: 'mdi:alert-octagon-outline', word: 'at limit' }
};

/**
 * How tight a scale to grade against.
 *
 * `panel` is for the meters you go and look at: it warns early, because there
 * the number is the point. `edge` is for the composer's own hairline and the
 * keys beside it, which you see whether you asked to or not — warning there at
 * 70% would leave the bar amber through most of a working session and teach
 * you to stop reading it.
 */
export type SeverityScale = 'panel' | 'edge';

const THRESHOLDS: Record<SeverityScale, { warning: number; critical: number }> = {
	panel: { warning: 70, critical: 90 },
	edge: { warning: 80, critical: 95 }
};

/** Severity of a plain utilisation percentage, for meters the server does not grade. */
export function severityForPercent(percent: number, scale: SeverityScale = 'panel'): Severity {
	const { warning, critical } = THRESHOLDS[scale];
	if (percent >= critical) return 'critical';
	if (percent >= warning) return 'warning';
	return 'normal';
}

/**
 * Meter colour for the composer's edge, where "normal" is not a state worth
 * colouring: the send button owns green, and a bar that is merely fine should
 * recede rather than announce itself.
 */
export function edgeColor(percent: number): string {
	const severity = severityForPercent(percent, 'edge');
	return severity === 'normal' ? '#78716c' : SEVERITY[severity].color;
}
