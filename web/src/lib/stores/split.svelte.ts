/**
 * Two sessions side by side.
 *
 * The URL is the state: `/session/A?with=B`. The layout reads it and hands
 * the two refs here; the store keeps what the URL does not — which pane has
 * focus, whether one is zoomed, where the divider sits, and whether a sidebar
 * row is being dragged — and turns every action into the next URL.
 *
 * A pane is a session page in an iframe (see SplitView), so a pane can be on
 * any host on the tailnet. Leaving the split for a single session goes to that
 * session's own host, the way the sidebar opens a remote session.
 */

import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { createPersisted } from './persisted';
import { serverStore } from './servers.svelte';
import { formatRef, sameRef, singleUrl, splitUrl, type PaneRef } from '$lib/split-refs';

export type PaneSide = 'a' | 'b';

const ratioStore = createPersisted<number>('claude-mux-split-ratio', 0.5);

/** Panes narrower than this lose their composer; below it the split is refused. */
export const MIN_PANE_PX = 440;

function navigate(url: string | null): void {
	if (!url) return;
	if (url.startsWith('/')) void goto(url);
	else window.location.href = url;
}

class SplitStore {
	a = $state<PaneRef | null>(null);
	b = $state<PaneRef | null>(null);
	focus = $state<PaneSide>('a');
	zoom = $state<PaneSide | null>(null);
	ratio = $state(0.5);
	/** A sidebar row is mid-drag: the panes show their drop targets. */
	dragging = $state(false);

	/** Both panes are set: the split is on. */
	active: boolean = $derived(this.a !== null && this.b !== null);

	constructor() {
		if (browser) {
			const saved = ratioStore.load();
			if (saved > 0.2 && saved < 0.8) this.ratio = saved;
		}
	}

	/** Called by the layout whenever the URL changes. */
	setPanes(a: PaneRef | null, b: PaneRef | null): void {
		if (!sameRef(this.a, a)) this.a = a;
		if (!sameRef(this.b, b)) this.b = b;
		if (!this.active) this.zoom = null;
	}

	pane(side: PaneSide): PaneRef | null {
		return side === 'a' ? this.a : this.b;
	}

	/** Which pane holds this session, if any. */
	sideOf(ref: PaneRef): PaneSide | null {
		if (sameRef(this.a, ref)) return 'a';
		if (sameRef(this.b, ref)) return 'b';
		return null;
	}

	setFocus(side: PaneSide): void {
		this.focus = side;
	}

	other(side: PaneSide): PaneSide {
		return side === 'a' ? 'b' : 'a';
	}

	/**
	 * Open a session in a pane. With no split on, the focused pane is the page
	 * itself and the other pane is the right half that does not exist yet:
	 * opening there is what starts a split.
	 */
	openIn(side: PaneSide | 'focus' | 'other', ref: PaneRef, current: PaneRef | null): void {
		const target: PaneSide = side === 'focus' ? this.focus : side === 'other' ? this.other(this.focus) : side;
		if (this.active && this.a && this.b) {
			const a = target === 'a' ? ref : this.a;
			const b = target === 'b' ? ref : this.b;
			if (sameRef(a, b)) return;
			navigate(splitUrl(a, b));
			this.focus = target;
			return;
		}
		if (target === 'b' && current && !sameRef(current, ref)) {
			navigate(splitUrl(current, ref));
			this.focus = 'b';
			return;
		}
		navigate(singleUrl(ref, serverStore.servers, serverStore.self));
	}

	/** Start a split with `ref` beside the session on the page. */
	splitWith(ref: PaneRef, current: PaneRef | null): void {
		if (!current || sameRef(current, ref)) return;
		navigate(splitUrl(current, ref));
		this.focus = 'b';
	}

	/** Close one pane; the other takes the whole width. */
	close(side: PaneSide): void {
		const keep = this.pane(this.other(side));
		if (!keep) return;
		this.zoom = null;
		this.focus = 'a';
		navigate(singleUrl(keep, serverStore.servers, serverStore.self));
	}

	swap(): void {
		if (!this.a || !this.b) return;
		this.focus = this.other(this.focus);
		if (this.zoom) this.zoom = this.other(this.zoom);
		navigate(splitUrl(this.b, this.a));
	}

	toggleZoom(side: PaneSide): void {
		this.zoom = this.zoom === side ? null : side;
		this.focus = side;
	}

	setRatio(ratio: number): void {
		this.ratio = Math.min(0.8, Math.max(0.2, ratio));
		ratioStore.save(this.ratio);
	}

	/** For the sidebar's A/B tags and titles. */
	label(ref: PaneRef): string {
		return formatRef(ref);
	}
}

export const splitStore = new SplitStore();
