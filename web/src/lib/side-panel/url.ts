/**
 * The side panel's half of the session page's URL.
 *
 * `?panel=<kind>` names the pane showing, and each pane owns a few plain query
 * params of its own (Changes `file` and `turn`, Files `file` and `line`, Web
 * `url`). Two panes may own a param of the same name, so switching panes drops
 * every pane param before setting the new pane's; the page's own params
 * (`view`, `embed`, `with`) are never touched.
 */

export const PANEL_PARAM = 'panel';

/** Which pane the URL asks for, if it is one of `kinds`. */
export function readPanel<K extends string>(params: URLSearchParams, kinds: readonly K[]): K | null {
	const kind = params.get(PANEL_PARAM);
	return kind && (kinds as readonly string[]).includes(kind) ? (kind as K) : null;
}

/** The params a pane owns, read off the URL. */
export function readPaneParams(params: URLSearchParams, owned: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of owned) {
		const value = params.get(name);
		if (value !== null) out[name] = value;
	}
	return out;
}

/**
 * The query after opening `kind` (or closing the panel, for null). `paneParams`
 * lists every param any pane owns; `own` sets this pane's, a null value
 * removing one. Opening the pane already showing keeps the params it has.
 */
export function panelQuery(
	params: URLSearchParams,
	kind: string | null,
	paneParams: readonly string[],
	own: Record<string, string | null> = {}
): URLSearchParams {
	const next = new URLSearchParams(params);
	if (kind === null || next.get(PANEL_PARAM) !== kind) {
		for (const name of paneParams) next.delete(name);
	}
	if (kind === null) {
		next.delete(PANEL_PARAM);
		return next;
	}
	next.set(PANEL_PARAM, kind);
	for (const [name, value] of Object.entries(own)) {
		if (value === null) next.delete(name);
		else next.set(name, value);
	}
	return next;
}
