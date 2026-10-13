import { Marked, type MarkedOptions, type Token, type Tokens } from 'marked';
import { findFilePaths, parseFilePath, type FilePath } from './file-paths';

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

/** Where a file named in a message opens, given its path and line. */
export type FileHref = (path: string, line: number | null) => string;

/** A file path found in a message: `text` is what was written, `code` whether in backticks. */
type FileLinkToken = Tokens.Generic &
	FilePath & { type: 'fileLink'; text: string; code: boolean; href: string };

/** Makes the token for a path written as `text`, in backticks or not. */
type MakeFileLink = (text: string, hit: FilePath, code: boolean) => FileLinkToken;

/** The file paths in one plain text token, cut out of it as tokens of their own. */
function splitFilePaths(t: Tokens.Text, link: MakeFileLink): Token[] {
	const hits = findFilePaths(t.text);
	if (hits.length === 0) return [t];
	const out: Token[] = [];
	let at = 0;
	const text = (to: number) => {
		if (to > at) out.push({ ...t, raw: t.text.slice(at, to), text: t.text.slice(at, to) });
	};
	for (const hit of hits) {
		text(hit.start);
		out.push(link(t.text.slice(hit.start, hit.end), hit, false));
		at = hit.end;
	}
	text(t.text.length);
	return out;
}

/**
 * Turn the file paths in a token tree into `fileLink` tokens: an inline code
 * span that is a path and nothing else, and paths written in plain text.
 * Links and code blocks are left as they are.
 */
function linkFiles(tokens: Token[], link: MakeFileLink): Token[] {
	return tokens.flatMap((t): Token[] => {
		if (t.type === 'link' || t.type === 'image') return [t];
		if (t.type === 'codespan') {
			const hit = parseFilePath(t.text);
			return [hit ? link(t.text, hit, true) : t];
		}
		if (t.type === 'text' && !t.tokens) return splitFilePaths(t as Tokens.Text, link);
		if ('tokens' in t && t.tokens) t.tokens = linkFiles(t.tokens, link);
		if (t.type === 'list') for (const item of (t as Tokens.List).items) item.tokens = linkFiles(item.tokens, link);
		if (t.type === 'table') {
			const table = t as Tokens.Table;
			for (const cell of [...table.header, ...table.rows.flat()]) cell.tokens = linkFiles(cell.tokens, link);
		}
		return [t];
	});
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
	extensions: [
		{
			name: 'fileLink',
			renderer(token) {
				const { text, path, line, code, href } = token as FileLinkToken;
				const label = code ? `<code>${escapeHtml(text)}</code>` : escapeHtml(text);
				const at = line ? ` data-line="${line}"` : '';
				return `<a class="file-link" href="${escapeHtml(href)}" data-file="${escapeHtml(path)}"${at}>${label}</a>`;
			}
		}
	],
	hooks: {
		processAllTokens(tokens) {
			breakParagraphs(tokens);
			// `renderMarkdown` passes the link function as an option of its own call.
			const fileHref = (this.options as { fileHref?: FileHref }).fileHref;
			if (!fileHref) return tokens;
			return linkFiles(tokens, (text, hit, code) => ({
				type: 'fileLink',
				raw: text,
				text,
				code,
				path: hit.path,
				line: hit.line,
				href: fileHref(hit.path, hit.line)
			}));
		}
	}
});

/**
 * Render a message. With `files`, a file path in it (in backticks or in plain
 * text) becomes an `a.file-link` to wherever `files` says that file opens,
 * carrying the path and line as `data-file` and `data-line`.
 */
export function renderMarkdown(text: string, files?: FileHref): string {
	try {
		return marked.parse(text, { async: false, fileHref: files } as MarkedOptions & { async: false });
	} catch {
		return `<pre>${escapeHtml(text)}</pre>`;
	}
}
