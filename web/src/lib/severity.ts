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

/** Severity of a plain utilisation percentage, for meters the server does not grade. */
export function severityForPercent(percent: number): Severity {
	if (percent >= 90) return 'critical';
	if (percent >= 70) return 'warning';
	return 'normal';
}
