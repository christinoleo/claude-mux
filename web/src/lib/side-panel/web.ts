/**
 * The Web pane's logic, apart from the component: which URL a choice names,
 * and how a URL can be shown from the device the page is open on.
 *
 * claude-mux is usually reached over HTTPS through tailscale serve, so an
 * `http://` page cannot be framed (mixed content), and a `localhost` URL means
 * the phone itself when opened on the phone. A dev server on this machine is
 * therefore framed through its tailscale serve HTTPS mapping when it has one,
 * and otherwise offered in a new tab with the command that would map it.
 */
import { isLoopback } from '$shared/utils/loopback.js';
import type { DevServer, TailnetInfo, WebInfo } from '$shared/server/web-preview.js';

export type { DevServer, FrameCheck, WebInfo } from '$shared/server/web-preview.js';

/** The named choices; anything else in `?url=` is a URL typed by hand. */
export type WebChoice = 'prod' | 'dev';

/**
 * The URL a choice names. `dev` falls back to the first dev server found
 * running in the project when `.claude-mux.json` names none.
 */
export function choiceUrl(choice: string, info: Pick<WebInfo, 'urls' | 'detected'> | null): string | null {
	if (choice === 'prod') return info?.urls.prod ?? null;
	if (choice === 'dev') return info?.urls.dev ?? info?.detected[0]?.url ?? null;
	return choice;
}

/** A URL typed into the bar, given a scheme when it has none. Null when it will not parse. */
export function normalizeTyped(text: string): string | null {
	const t = text.trim();
	if (!t) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t)
		? t
		: `${/^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/i.test(t) ? 'http' : 'https'}://${t}`;
	try {
		const u = new URL(withScheme);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
	} catch {
		return null;
	}
}

/** A URL that points at the machine claude-mux runs on. */
function pointsHere(u: URL): boolean {
	return isLoopback(u.hostname) || u.hostname === '0.0.0.0';
}

function portOf(u: URL): number {
	return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

export type Embed =
	| {
			kind: 'frame';
			src: string;
			/** Shown above the frame without stopping it. */
			warn?: string;
	  }
	| {
			kind: 'card';
			/** Why it cannot be framed from here. */
			reason: string;
			/** The URL that opens it in a tab of its own. */
			open: string;
			/** The command that would make it embeddable. */
			command?: string;
			warn?: string;
	  };

export interface EmbedContext {
	/** Where this page is open: `location`. */
	page: { protocol: string; hostname: string };
	tailnet: TailnetInfo;
	detected: DevServer[];
}

/** How `target` can be shown in the pane from the page in `ctx`. */
export function resolveEmbed(target: string, ctx: EmbedContext): Embed {
	const u = new URL(target);
	const pageSecure = ctx.page.protocol === 'https:';
	if (!pointsHere(u)) {
		if (pageSecure && u.protocol === 'http:') {
			return {
				kind: 'card',
				reason: 'This page is served over HTTPS, and browsers will not frame a plain-HTTP page inside it.',
				open: u.href
			};
		}
		return { kind: 'frame', src: u.href };
	}

	const port = portOf(u);
	const served = ctx.tailnet.serves[port];
	if (served) {
		return { kind: 'frame', src: `${served}${u.pathname}${u.search}${u.hash}` };
	}
	// Opened on the machine itself, localhost is the same machine, and browsers treat it as secure.
	if (isLoopback(ctx.page.hostname)) {
		return { kind: 'frame', src: u.href.replace('//0.0.0.0', '//localhost') };
	}

	const host = ctx.tailnet.host ?? ctx.page.hostname;
	const remote = new URL(u.href);
	remote.hostname = host;
	const loopbackOnly = ctx.detected.find((d) => d.port === port)?.loopbackOnly === true;
	const warn = loopbackOnly
		? `The server on port ${port} listens on 127.0.0.1 only, so nothing off this machine reaches it directly. Restart it bound to 0.0.0.0, or map it with tailscale serve.`
		: undefined;
	if (pageSecure && remote.protocol === 'http:') {
		return {
			kind: 'card',
			reason: `Port ${port} has no tailscale serve HTTPS mapping, and this page, served over HTTPS, cannot frame plain HTTP.`,
			open: remote.href,
			command: `tailscale serve --bg --https=${port} http://localhost:${port}`,
			warn
		};
	}
	return { kind: 'frame', src: remote.href, warn };
}
