/**
 * Syntax colouring for the Files pane, loaded the first time a file is shown
 * so the session page does not carry Shiki until the pane is opened. The
 * fine-grained build: Shiki's core, its JavaScript regex engine (no WASM),
 * one theme, and a grammar only when a file of that language is opened.
 * Anything else is drawn plain.
 */
import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS: Record<string, Grammar> = {
	typescript: () => import('shiki/langs/typescript.mjs'),
	tsx: () => import('shiki/langs/tsx.mjs'),
	javascript: () => import('shiki/langs/javascript.mjs'),
	jsx: () => import('shiki/langs/jsx.mjs'),
	svelte: () => import('shiki/langs/svelte.mjs'),
	html: () => import('shiki/langs/html.mjs'),
	xml: () => import('shiki/langs/xml.mjs'),
	css: () => import('shiki/langs/css.mjs'),
	scss: () => import('shiki/langs/scss.mjs'),
	json: () => import('shiki/langs/json.mjs'),
	jsonc: () => import('shiki/langs/jsonc.mjs'),
	markdown: () => import('shiki/langs/markdown.mjs'),
	python: () => import('shiki/langs/python.mjs'),
	shellscript: () => import('shiki/langs/shellscript.mjs'),
	yaml: () => import('shiki/langs/yaml.mjs'),
	toml: () => import('shiki/langs/toml.mjs'),
	rust: () => import('shiki/langs/rust.mjs'),
	go: () => import('shiki/langs/go.mjs'),
	sql: () => import('shiki/langs/sql.mjs'),
	diff: () => import('shiki/langs/diff.mjs'),
	docker: () => import('shiki/langs/docker.mjs'),
	make: () => import('shiki/langs/make.mjs')
};

const THEME = 'github-dark-default';

/** Text longer than this is drawn plain: tokenizing it would stall the page. */
const HIGHLIGHT_LIMIT_CHARS = 400_000;

let core: Promise<HighlighterCore> | null = null;

function highlighter(): Promise<HighlighterCore> {
	return (core ??= (async () => {
		const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
			import('shiki/core'),
			import('shiki/engine/javascript'),
			import('shiki/themes/github-dark-default.mjs')
		]);
		return createHighlighterCore({ themes: [theme.default], langs: [], engine: createJavaScriptRegexEngine() });
	})());
}

/**
 * Each line's tokens with their colours, or null when the language is not one
 * this loads or the text is too long (the caller then draws it plain).
 */
export async function highlightFile(text: string, language: string | null): Promise<ThemedToken[][] | null> {
	if (!language || !GRAMMARS[language] || text.length > HIGHLIGHT_LIMIT_CHARS) return null;
	const shiki = await highlighter();
	if (!shiki.getLoadedLanguages().includes(language)) await shiki.loadLanguage((await GRAMMARS[language]()).default);
	return shiki.codeToTokens(text, { lang: language, theme: THEME }).tokens;
}
