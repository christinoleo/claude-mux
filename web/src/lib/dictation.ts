import { tick } from 'svelte';

/** Where a field's caret stands: equal ends for a caret, a span for a selection. */
export interface Spot {
	start: number;
	end: number;
}

/** A field's text with what was said in it, and where the caret goes after the words. */
export interface Inserted {
	text: string;
	caret: number;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * Text that closes up on what comes before it, so words set in front need no
 * space. Straight quotes are left out: they open a quotation as often as close one.
 */
const CLOSES_UP = /^[\s.,;:!?)\]}…’”]/;

/**
 * `text` with `said` put in at `spot`, replacing whatever it selects. Without
 * a spot, or with nothing but whitespace after the caret, the words join the
 * end the way they always have: trailing whitespace folds into one space.
 * Elsewhere a space goes in on each side the neighbouring text does not
 * already provide.
 */
export function insertSaid(text: string, said: string, spot: Spot | null): Inserted {
	const start = Math.min(spot?.start ?? text.length, text.length);
	const end = Math.min(spot?.end ?? text.length, text.length);
	const before = text.slice(0, start);
	const after = text.slice(end);
	if (!after.trim()) {
		const joined = before.trim() ? `${before.trimEnd()} ${said}` : said;
		return { text: joined, caret: joined.length };
	}
	const lead = before && !/\s$/.test(before) ? ' ' : '';
	const tail = CLOSES_UP.test(after) ? '' : ' ';
	const caret = before.length + lead.length + said.length;
	return { text: `${before}${lead}${said}${tail}${after}`, caret };
}

/**
 * Where each field's caret stood when it last lost focus, beside the text it
 * held then. Tapping a microphone takes focus from the field, and a phone may
 * move a blurred field's selection, so the spot is read on the way out.
 */
const kept = new WeakMap<Field, { value: string; spot: Spot }>();

function spotOf(el: Field): Spot | null {
	if (el.selectionStart == null) return null;
	return { start: el.selectionStart, end: el.selectionEnd ?? el.selectionStart };
}

/**
 * Attachment for a field dictation writes into (`{@attach keepsCaret}`): it
 * keeps the caret the field leaves with, which `caretOf` reads once the
 * microphone has taken focus.
 */
export function keepsCaret(el: Field): () => void {
	const keep = () => {
		const spot = spotOf(el);
		if (spot) kept.set(el, { value: el.value, spot });
	};
	el.addEventListener('focusout', keep);
	return () => el.removeEventListener('focusout', keep);
}

/**
 * Where dictation into `el` should go: its live caret while it has focus, the
 * caret it left with when its text has not changed since, and null when nobody
 * placed one (never focused, or the text was replaced behind its back), which
 * means the end.
 */
export function caretOf(el: Field | null | undefined): Spot | null {
	if (!el) return null;
	const live = document.activeElement === el ? spotOf(el) : null;
	if (live) return live;
	const left = kept.get(el);
	return left && left.value === el.value ? left.spot : null;
}

/** Focus `el` with the caret at `caret`, so the next take carries on from there. */
export function putCaret(el: Field | null | undefined, caret: number): void {
	if (!el) return;
	el.focus();
	el.setSelectionRange(caret, caret);
}

/**
 * Put what was said into `field` where its caret stands, through `write`, and
 * leave the caret after the words; with no caret placed they join the end.
 */
export async function sayInto(
	field: Field | null | undefined,
	current: string,
	said: string,
	write: (text: string) => void
): Promise<void> {
	const spot = caretOf(field);
	const next = insertSaid(current, said, spot);
	write(next.text);
	if (!spot) return;
	await tick();
	putCaret(field, next.caret);
}
