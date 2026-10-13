/**
 * Quoting transcript text into the composer: what counts as quotable, how a
 * selection is read, and the markdown it becomes in the draft.
 */

/**
 * The parts of the transcript that hold words someone wrote or a tool
 * printed. Everything else under it (a tool row's summary, a timestamp, a
 * badge, a button) is chrome, and a selection of nothing else quotes nothing.
 */
const QUOTABLE = '.user-text, .markdown, .thinking-text, pre';
/** Fields and buttons keep their own selection and keys. */
const NOT_QUOTABLE = 'button, textarea, input';

/** The selection as a markdown blockquote: `> ` on each line, runs of blank lines folded to one. */
export function quoteBlock(text: string): string {
	const lines = text
		.replace(/\r\n?/g, '\n')
		.replace(/\n[^\S\n]*(?:\n[^\S\n]*)+/g, '\n\n')
		.trim();
	if (!lines) return '';
	return lines
		.split('\n')
		.map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
		.join('\n');
}

/**
 * The draft with the selection quoted at its end and a blank line after, so
 * the caret, put at the end, sits where the reply goes. What was already
 * typed stays; a selection of nothing leaves the draft as it was.
 */
export function appendQuote(draft: string, text: string): string {
	const quote = quoteBlock(text);
	if (!quote) return draft;
	const before = draft.trimEnd();
	return `${before ? `${before}\n\n` : ''}${quote}\n\n`;
}

function outermost(el: Element, root: Element): boolean {
	const outer = el.parentElement?.closest(QUOTABLE);
	return !outer || !root.contains(outer);
}

/**
 * The quotable stretches of a selection inside `root`, one range per message
 * part it touches, in document order. Empty when the selection is collapsed,
 * sits outside `root`, or covers nothing but chrome.
 */
export function quotableRanges(root: Element, selection: Selection | null): Range[] {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
	const range = selection.getRangeAt(0);
	const common = range.commonAncestorContainer;
	const scope = common instanceof Element ? common : common.parentElement;
	if (!scope || !(root.contains(scope) || scope.contains(root))) return [];

	// A selection inside one message part is the usual case, and needs no search.
	const within = root.contains(scope) ? scope.closest(QUOTABLE) : null;
	const parts =
		within && root.contains(within)
			? [within]
			: [...(scope.contains(root) ? root : scope).querySelectorAll(QUOTABLE)].filter(
					(el) => outermost(el, root) && range.intersectsNode(el)
				);

	const ranges: Range[] = [];
	for (const part of parts) {
		if (part.closest(NOT_QUOTABLE)) continue;
		const clipped = range.cloneRange();
		const whole = document.createRange();
		whole.selectNodeContents(part);
		if (clipped.compareBoundaryPoints(Range.START_TO_START, whole) < 0) {
			clipped.setStart(whole.startContainer, whole.startOffset);
		}
		if (clipped.compareBoundaryPoints(Range.END_TO_END, whole) > 0) {
			clipped.setEnd(whole.endContainer, whole.endOffset);
		}
		if (clipped.toString().trim()) ranges.push(clipped);
	}
	return ranges;
}

/** On the page while a quote is read: app.css draws a GitHub chip as the plain `#n` it stands for. */
const QUOTING = 'quoting';

/**
 * The text of those ranges as the reader sees it, then the selection cleared.
 * Only a selection's own `toString()` keeps the line breaks between blocks
 * (a range's joins every text node end to end), so each range is selected in
 * turn to be read; a part is parted from the next by a blank line.
 */
export function takeQuote(ranges: Range[]): string {
	const selection = window.getSelection();
	if (!selection) return ranges.map((r) => r.toString().trim()).join('\n\n');
	const page = document.documentElement;
	const parts: string[] = [];
	page.classList.add(QUOTING);
	try {
		for (const range of ranges) {
			selection.removeAllRanges();
			selection.addRange(range);
			parts.push(selection.toString().trim());
		}
	} finally {
		selection.removeAllRanges();
		page.classList.remove(QUOTING);
	}
	return parts.filter(Boolean).join('\n\n');
}
