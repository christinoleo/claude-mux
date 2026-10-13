import { Marked, type MarkedOptions, type Token, type Tokens } from 'marked';
import { isRefShorthand, parseGithubRefUrl } from '$shared/github-ref.js';
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

export interface MarkdownOptions {
	/** Turns a file path into an `a.file-link` to wherever this says the file opens. */
	files?: FileHref;
	/** Marks links to GitHub pull requests and issues as `a.gh-ref`; with `bare`, a `#123` in plain text too. */
	github?: { bare?: boolean };
}

/** A file path found in a message: `text` is what was written, `code` whether in backticks. */
type FileLinkToken = Tokens.Generic &
	FilePath & { type: 'fileLink'; text: string; code: boolean; href: string };

/**
 * A pull request or issue named in a message. A link to one carries its
 * repo and URL as `link` and, when the author wrote words of their own, those
 * as `tokens`; a bare `#123` carries only the number, and is no link until it
 * resolves.
 */
type GithubRefToken = Tokens.Generic & {
	type: 'githubRef';
	text: string;
	number: number;
	link: { repo: string; href: string } | null;
	tokens?: Token[];
};

/** Something found in a run of plain text, with where it sits. */
interface TextHit {
	start: number;
	end: number;
}

/** Cut `hits` out of one plain text token as tokens of their own, keeping the text between. */
function splitText<H extends TextHit>(t: Tokens.Text, hits: H[], make: (text: string, hit: H) => Token): Token[] {
	if (hits.length === 0) return [t];
	const out: Token[] = [];
	let at = 0;
	const text = (to: number) => {
		if (to > at) out.push({ ...t, raw: t.text.slice(at, to), text: t.text.slice(at, to) });
	};
	for (const hit of hits) {
		text(hit.start);
		out.push(make(t.text.slice(hit.start, hit.end), hit));
		at = hit.end;
	}
	text(t.text.length);
	return out;
}

/** What replaces an inline token, or null to leave it and look inside it. */
type Rewrite = (t: Token) => Token[] | null;

/** Rewrite the inline tokens of a tree, down through lists and tables. Code blocks have none. */
function rewriteInline(tokens: Token[], rewrite: Rewrite): Token[] {
	return tokens.flatMap((t): Token[] => {
		const swapped = rewrite(t);
		if (swapped) return swapped;
		if ('tokens' in t && t.tokens) t.tokens = rewriteInline(t.tokens, rewrite);
		if (t.type === 'list') for (const item of (t as Tokens.List).items) item.tokens = rewriteInline(item.tokens, rewrite);
		if (t.type === 'table') {
			const table = t as Tokens.Table;
			for (const cell of [...table.header, ...table.rows.flat()]) cell.tokens = rewriteInline(cell.tokens, rewrite);
		}
		return [t];
	});
}

/**
 * A `#123` standing on its own: not an HTML entity, a URL's fragment or the
 * tail of a word. Five digits at most, which leaves a colour such as `#111827`
 * alone; a `#333` is told from an issue only by whether GitHub knows it.
 */
const BARE_REF = /(?<![\w&#/])#([1-9]\d{0,4})(?![\w-])/g;

/** Whether a token is plain text with nothing nested in it. */
function isPlainText(t: Token): t is Tokens.Text {
	return t.type === 'text' && !('tokens' in t && t.tokens);
}

/**
 * The rewrite one message's options ask for: a link to a pull request or
 * issue becomes a `githubRef`; an inline code span that is a path and nothing
 * else, and a path in plain text, a `fileLink`; a bare `#123`, a `githubRef`
 * with no `link`. Other links, images and code are left as they are.
 */
function rewriteFor({ files, github }: MarkdownOptions): Rewrite {
	const fileLink = (text: string, hit: FilePath, code: boolean): FileLinkToken => ({
		type: 'fileLink',
		raw: text,
		text,
		code,
		path: hit.path,
		line: hit.line,
		href: files!(hit.path, hit.line)
	});
	const bareRefs = (t: Token): Token[] => {
		if (!github?.bare || !isPlainText(t)) return [t];
		const hits = [...t.text.matchAll(BARE_REF)].map((m) => ({
			start: m.index,
			end: m.index + m[0].length,
			number: Number(m[1])
		}));
		return splitText(
			t,
			hits,
			(text, hit): GithubRefToken => ({ type: 'githubRef', raw: text, text, number: hit.number, link: null })
		);
	};
	return (t) => {
		if (t.type === 'link') {
			const link = t as Tokens.Link;
			const target = github ? parseGithubRefUrl(link.href) : null;
			if (!target) return [t];
			// An autolink's text is its URL, and `#12` only names the target: neither is the author's words.
			const named = link.text !== link.href && !isRefShorthand(link.text, target);
			const ref: GithubRefToken = {
				type: 'githubRef',
				raw: link.raw,
				text: link.text,
				number: target.number,
				link: { repo: target.repo, href: link.href },
				...(named ? { tokens: link.tokens } : {})
			};
			return [ref];
		}
		if (t.type === 'image') return [t];
		if (t.type === 'codespan') {
			const hit = files ? parseFilePath(t.text) : null;
			return [hit ? fileLink(t.text, hit, true) : t];
		}
		if (!isPlainText(t)) return null;
		if (!files) return bareRefs(t);
		return splitText(t, findFilePaths(t.text), (text, hit) => fileLink(text, hit, false)).flatMap(bareRefs);
	};
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
		},
		{
			name: 'githubRef',
			renderer(token) {
				const { text, number, link, tokens } = token as GithubRefToken;
				if (!link) return `<a class="gh-ref" data-number="${number}">${escapeHtml(text)}</a>`;
				const label = tokens ? this.parser.parseInline(tokens) : escapeHtml(text);
				const attrs =
					`href="${escapeHtml(link.href)}" target="_blank" rel="noopener" data-repo="${escapeHtml(link.repo)}"` +
					` data-number="${number}"${tokens ? ' data-words' : ''}`;
				return `<a class="gh-ref" ${attrs}>${label}</a>`;
			}
		}
	],
	hooks: {
		processAllTokens(tokens) {
			breakParagraphs(tokens);
			// `renderMarkdown` passes its own options along with marked's.
			const options = this.options as MarkdownOptions;
			if (!options.files && !options.github) return tokens;
			return rewriteInline(tokens, rewriteFor(options));
		}
	}
});

/**
 * Render a message. With `files`, a file path in it (in backticks or in plain
 * text) becomes an `a.file-link` to wherever `files` says that file opens,
 * carrying the path and line as `data-file` and `data-line`. With `github`, a
 * link to a pull request or issue becomes an `a.gh-ref` carrying `data-repo`
 * and `data-number` (and `data-words` when its text is the author's own), for
 * the transcript to draw as a chip once GitHub has answered.
 */
export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
	try {
		return marked.parse(text, { async: false, ...options } as MarkedOptions & { async: false });
	} catch {
		return `<pre>${escapeHtml(text)}</pre>`;
	}
}
