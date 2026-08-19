import { AnsiUp } from 'ansi_up';

const ansi = new AnsiUp();
ansi.use_classes = true;

// OSC 8 hyperlinks: ESC ] 8 ; params ; URI ST TEXT ESC ] 8 ; ; ST
// ST is either ESC \ or BEL (\x07). ansi_up doesn't parse these, so
// extract them, run ansi_up on the text, then re-wrap in <a>.
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x1b\\|\x07)([\s\S]*?)\x1b\]8;;(?:\x1b\\|\x07)/g;

// CSI / OSC / other escapes, for plain-text rendering
const ANSI_STRIP_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isSafeUrl(u: string): boolean {
	return /^(https?:|mailto:|ftp:)/i.test(u);
}

/** ANSI text → HTML (ansi_up class-based colors + OSC 8 links). */
export function ansiToHtml(input: string): string {
	const links: string[] = [];
	const marked = input.replace(OSC8_RE, (_m, uri: string, text: string) => {
		const i = links.push(uri) - 1;
		return `\x00CMX${i}S\x00${text}\x00CMX${i}E\x00`;
	});
	let html = ansi.ansi_to_html(marked);
	html = html.replace(/\x00CMX(\d+)S\x00([\s\S]*?)\x00CMX\1E\x00/g, (_m, i, inner) => {
		const uri = links[Number(i)] ?? '';
		if (!isSafeUrl(uri)) return inner;
		return `<a href="${escapeAttr(uri)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
	});
	return html;
}

/**
 * Render one terminal line in isolation. ansi_up carries SGR state across
 * calls; a leading reset keeps lines independent so cached HTML stays valid.
 */
export function ansiLineToHtml(line: string): string {
	return ansiToHtml('\x1b[0m' + line);
}

export function stripAnsi(input: string): string {
	return input.replace(ANSI_STRIP_RE, '');
}
