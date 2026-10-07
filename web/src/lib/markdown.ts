import { Marked, type Token } from 'marked';

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** Split every soft newline in a run of inline tokens into a hard break. */
function hardBreak(tokens: Token[]): Token[] {
	return tokens.flatMap((t): Token[] => {
		if (t.type === 'text' && !t.tokens && t.text.includes('\n')) {
			return t.text.split('\n').flatMap((text: string, i: number): Token[] => [
				...(i > 0 ? [{ type: 'br', raw: '\n' } as Token] : []),
				...(text ? [{ ...t, raw: text, text }] : [])
			]);
		}
		if ('tokens' in t && t.tokens && t.type !== 'codespan') t.tokens = hardBreak(t.tokens);
		return [t];
	});
}

/** Paragraphs, including those quoted, get hard breaks; lists are left alone. */
function breakParagraphs(tokens: Token[]): void {
	for (const t of tokens) {
		if (t.type === 'paragraph') t.tokens = hardBreak(t.tokens ?? []);
		else if (t.type === 'blockquote') breakParagraphs(t.tokens ?? []);
	}
}

// Raw HTML in model output is rendered as literal text, not injected.
//
// Line breaks follow the TUI, which prints a reply's lines as written: a
// single newline inside a plain paragraph is a line break, so a reply that
// lists numbers one per line reads one per line rather than "1 2 3 … 80".
// The global `breaks` option would do that everywhere, and inside lists it
// hard-breaks every continuation line and doubles their rhythm, so it stays
// off and only paragraphs (top level or quoted) are rewritten. Lists, and
// the lines that continue a list item, render as standard markdown.
const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html({ raw }) {
			return escapeHtml(raw);
		}
	},
	hooks: {
		processAllTokens(tokens) {
			breakParagraphs(tokens);
			return tokens;
		}
	}
});

export function renderMarkdown(text: string): string {
	try {
		return marked.parse(text, { async: false });
	} catch {
		return `<pre>${escapeHtml(text)}</pre>`;
	}
}
