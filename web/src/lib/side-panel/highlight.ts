/**
 * Syntax colouring for the Changes pane's diff, loaded the first time a diff
 * is drawn so the session page does not carry highlight.js until then.
 *
 * Lines are coloured one at a time: a diff shows fragments, so a construct
 * that opens above the hunk (a block comment, a template string) is never
 * seen whole anyway, and per line keeps a bad guess from spilling further.
 */
import type { HLJSApi, LanguageFn } from 'highlight.js';

let loading: Promise<HLJSApi> | null = null;

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
	typescript: () => import('highlight.js/lib/languages/typescript'),
	javascript: () => import('highlight.js/lib/languages/javascript'),
	xml: () => import('highlight.js/lib/languages/xml'),
	css: () => import('highlight.js/lib/languages/css'),
	scss: () => import('highlight.js/lib/languages/scss'),
	json: () => import('highlight.js/lib/languages/json'),
	markdown: () => import('highlight.js/lib/languages/markdown'),
	python: () => import('highlight.js/lib/languages/python'),
	bash: () => import('highlight.js/lib/languages/bash'),
	yaml: () => import('highlight.js/lib/languages/yaml'),
	ini: () => import('highlight.js/lib/languages/ini'),
	rust: () => import('highlight.js/lib/languages/rust'),
	go: () => import('highlight.js/lib/languages/go'),
	sql: () => import('highlight.js/lib/languages/sql'),
	java: () => import('highlight.js/lib/languages/java'),
	kotlin: () => import('highlight.js/lib/languages/kotlin'),
	c: () => import('highlight.js/lib/languages/c'),
	cpp: () => import('highlight.js/lib/languages/cpp'),
	ruby: () => import('highlight.js/lib/languages/ruby'),
	php: () => import('highlight.js/lib/languages/php'),
	swift: () => import('highlight.js/lib/languages/swift'),
	lua: () => import('highlight.js/lib/languages/lua'),
	dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
	makefile: () => import('highlight.js/lib/languages/makefile')
};

const core = () => (loading ??= import('highlight.js/lib/core').then((m) => m.default));

/**
 * Each line as escaped HTML with highlight.js's token spans, or null when the
 * language is unknown (the caller then draws the text as is).
 */
export async function highlightLines(lines: string[], language: string | null): Promise<string[] | null> {
	if (!language || !LOADERS[language]) return null;
	const load = LOADERS[language];
	const hljs = await core();
	if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await load()).default);
	return lines.map((line) => hljs.highlight(line, { language, ignoreIllegals: true }).value);
}
