/**
 * What a pull request's or issue's body needs beyond the transcript's
 * markdown: GitHub's alerts, and the HTML people and bots write into a body
 * (`<details>`, `<img>`, `<br>`, `<sub>`…), kept to tags and attributes that
 * can only draw, never run or reach out except through the media function.
 */

import type { Token, Tokens } from 'marked';

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export const GITHUB_ALERTS: Record<AlertKind, string> = {
	note: 'Note',
	tip: 'Tip',
	important: 'Important',
	warning: 'Warning',
	caution: 'Caution'
};

/** Where an image is drawn from, given the address the body wrote; null leaves it out. */
export type MediaHref = (url: string) => string | null;

/** The marker on a quote's first line, alone on it: GitHub's rule for an alert. */
const ALERT_MARK = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/**
 * Mark each quote that opens with `[!NOTE]` (or TIP, IMPORTANT, WARNING,
 * CAUTION) alone on its first line as that alert, and take the marker out.
 * A marker with text after it on the same line leaves a plain quote.
 */
export function markAlerts(tokens: Token[]): void {
	for (const t of tokens) {
		if (t.type !== 'blockquote') continue;
		const quote = t as Tokens.Blockquote & { alert?: AlertKind };
		const first = quote.tokens[0];
		if (first?.type !== 'paragraph') {
			markAlerts(quote.tokens);
			continue;
		}
		const para = first as Tokens.Paragraph;
		const lead = para.tokens[0];
		const mark = lead?.type === 'text' ? ALERT_MARK.exec((lead as Tokens.Text).text) : null;
		if (!mark) continue;
		quote.alert = mark[1].toLowerCase() as AlertKind;
		const rest = (lead as Tokens.Text).text.slice(mark[0].length);
		if (rest) {
			para.tokens[0] = { ...lead, raw: rest, text: rest } as Tokens.Text;
		} else {
			para.tokens.shift();
			if (para.tokens.length === 0) quote.tokens.shift();
		}
	}
}

/** Tags a body may keep, with the attributes each may carry. */
const ALLOWED: Record<string, readonly string[]> = {
	details: ['open'],
	summary: [],
	br: [],
	hr: [],
	p: ['align'],
	div: ['align'],
	span: [],
	sub: [],
	sup: [],
	b: [],
	strong: [],
	i: [],
	em: [],
	s: [],
	del: [],
	ins: [],
	u: [],
	mark: [],
	small: [],
	code: [],
	kbd: [],
	pre: [],
	blockquote: [],
	ul: [],
	ol: ['start'],
	li: [],
	dl: [],
	dt: [],
	dd: [],
	table: [],
	thead: [],
	tbody: [],
	tr: [],
	th: ['align', 'colspan', 'rowspan'],
	td: ['align', 'colspan', 'rowspan'],
	h1: [],
	h2: [],
	h3: [],
	h4: [],
	h5: [],
	h6: [],
	img: ['src', 'alt', 'width', 'height', 'title'],
	a: ['href', 'title']
};

const VOID = new Set(['br', 'hr', 'img']);

function escapeText(text: string): string {
	return text
		.replace(/&(?!#?\w+;)/g, '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

function decodeAttr(value: string): string {
	return value
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');
}

function escapeAttr(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function isWebUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** One tag rebuilt from what it may carry, or null when it may not stay. */
function rebuildTag(name: string, closing: boolean, attrs: string, media: MediaHref): string | null {
	const allowed = ALLOWED[name];
	if (!allowed) return null;
	if (closing) return VOID.has(name) ? '' : `</${name}>`;
	const kept: string[] = [];
	for (const m of attrs.matchAll(ATTR)) {
		const attr = m[1].toLowerCase();
		if (!allowed.includes(attr)) continue;
		const value = decodeAttr(m[2] ?? m[3] ?? m[4] ?? '');
		if (attr === 'src') {
			const src = isWebUrl(value) ? media(value) : null;
			if (!src) return name === 'img' ? '' : null;
			kept.push(`src="${escapeAttr(src)}"`);
		} else if (attr === 'href') {
			if (isWebUrl(value) || value.startsWith('#')) kept.push(`href="${escapeAttr(value)}"`);
		} else if (attr === 'open') {
			kept.push('open');
		} else {
			kept.push(`${attr}="${escapeAttr(value)}"`);
		}
	}
	if (name === 'img') {
		if (!kept.some((a) => a.startsWith('src='))) return '';
		kept.push('loading="lazy"');
	}
	if (name === 'a') kept.push('target="_blank"', 'rel="noopener"');
	return `<${name}${kept.length ? ' ' + kept.join(' ') : ''}>`;
}

const PIECE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;

/**
 * Raw HTML from a body, kept to the tags in `ALLOWED` with only their
 * allowed attributes; comments are dropped, links open in a new tab, an
 * image's address goes through `media`, and every other tag is shown as the
 * text it was written as.
 */
export function sanitizeGithubHtml(raw: string, media: MediaHref): string {
	let out = '';
	let at = 0;
	for (const m of raw.matchAll(PIECE)) {
		out += escapeText(raw.slice(at, m.index));
		at = m.index + m[0].length;
		if (m[0].startsWith('<!--')) continue;
		const tag = rebuildTag(m[2].toLowerCase(), m[1] === '/', m[3], media);
		out += tag ?? escapeText(m[0]);
	}
	return out + escapeText(raw.slice(at));
}
