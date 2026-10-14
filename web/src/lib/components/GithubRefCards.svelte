<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { githubRefVisual, type GithubRef } from '$shared/github-ref.js';
	import { formatAgo } from '$lib/format';
	import { chipQuery, chipRef, drawChip, loadGithubRef } from '$lib/github-refs';
	import { loadGithubItem } from '$lib/github-items';

	// The chips arrive as HTML inside rendered messages, so nothing here is a
	// component per link: one observer finds them under `root` as they are
	// drawn, asks GitHub about each when it scrolls into view, and one card
	// serves whichever chip is under the pointer.
	let {
		root,
		session = null,
		repo = null,
		base = '',
		onOpen
	}: {
		/** The element whose messages hold the chips. */
		root: HTMLElement;
		/** The session whose repo a bare `#n` is looked up in; null where there is none. */
		session?: string | null;
		/** The repo a bare `#n` names, where the chips sit in one repo's text; it wins over `session`. */
		repo?: string | null;
		/** Where the machine that reads GitHub is reached: '' for this one, `/fleet/<id>` for another. */
		base?: string;
		/**
		 * Opens a chip in the GitHub pane, given its `owner/name#n`. With it a
		 * plain click or a tap opens the pane, and a hover warms the pane's read;
		 * Ctrl/Cmd-click and a middle click still go to github.com.
		 */
		onOpen?: (ref: string) => void;
	} = $props();

	const OPEN_MS = 250;
	const CLOSE_MS = 180;
	/** A link GitHub said nothing about is asked about once more, this long after. */
	const RETRY_MS = 20_000;

	let open = $state(false);
	let anchor = $state<HTMLAnchorElement | null>(null);
	let shown = $state<GithubRef | null>(null);
	let now = $state(Date.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Whether the press now under way began on the chip whose card was already up. */
	let pressedOpenChip = false;
	/** What made the last press. Safari's `click` does not say, so `pointerdown` is asked. */
	let pressedWith = 'mouse';
	/** Counts every wish to show or hide the card, so an answer that arrives late can tell it is. */
	let wish = 0;

	const visual = $derived(shown && githubRefVisual(shown));
	const ago = $derived(shown?.updated_at ? formatAgo(shown.updated_at, now) : '');

	const RESOLVED = 'a.gh-ref.resolved';

	function chipAt(target: EventTarget | null, selector = 'a.gh-ref'): HTMLAnchorElement | null {
		return target instanceof Element ? target.closest<HTMLAnchorElement>(selector) : null;
	}

	/** Ask about a chip and draw the answer into it; an answer of nothing leaves the link as written. */
	async function resolve(a: HTMLAnchorElement): Promise<GithubRef | null> {
		const query = chipQuery(a, { base, session, repo });
		if (!query) return null;
		const ref = await loadGithubRef(query);
		if (ref && a.isConnected) drawChip(a, ref);
		return ref;
	}

	async function show(a: HTMLAnchorElement) {
		const mine = ++wish;
		const ref = await resolve(a);
		// The pointer may have left while GitHub was being asked.
		if (!ref || !a.isConnected || mine !== wish) return;
		shown = ref;
		anchor = a;
		now = Date.now();
		open = true;
		// The click that may follow lands on a read already made.
		if (onOpen) void loadGithubItem(base, ref.repo, ref.number);
	}

	function later(ms: number, run: () => void) {
		clearTimeout(timer);
		timer = setTimeout(run, ms);
	}

	function hide() {
		wish++;
		later(CLOSE_MS, () => (open = false));
	}

	function onPointerOver(e: PointerEvent) {
		if (e.pointerType !== 'mouse') return;
		const a = chipAt(e.target, RESOLVED);
		if (!a) return;
		if (open && a === anchor) clearTimeout(timer);
		else later(OPEN_MS, () => void show(a));
	}

	function onPointerOut(e: PointerEvent) {
		if (e.pointerType !== 'mouse') return;
		const a = chipAt(e.target);
		if (a && !(e.relatedTarget instanceof Node && a.contains(e.relatedTarget))) hide();
	}

	function onPointerDown(e: PointerEvent) {
		pressedOpenChip = open && chipAt(e.target) === anchor;
		pressedWith = e.pointerType;
	}

	// With the pane to open, a plain click or a tap on a chip opens it there; a
	// modified click is the browser's, which takes the link to github.com.
	// Without one, a finger has no hover, so a tap on a chip opens its card,
	// which holds the way through to GitHub; a second tap puts the card away.
	// A link GitHub said nothing about is not a chip, and a tap follows it as ever.
	function onClick(e: MouseEvent) {
		const by = pressedWith;
		// A click from the keyboard has no press before it.
		pressedWith = 'mouse';
		const a = chipAt(e.target, RESOLVED);
		const ref = a && chipRef(a);
		if (onOpen && ref && !e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
			e.preventDefault();
			wish++;
			clearTimeout(timer);
			open = false;
			onOpen(ref);
			return;
		}
		if (by === 'mouse' || !a) return;
		e.preventDefault();
		if (pressedOpenChip) open = false;
		else void show(a);
	}

	function onFocusIn(e: FocusEvent) {
		const a = chipAt(e.target, RESOLVED);
		if (a?.matches(':focus-visible')) void show(a);
	}

	$effect(() => {
		const el = root;
		const retried = new WeakSet<Element>();
		const retries = new Set<ReturnType<typeof setTimeout>>();
		const inView = new IntersectionObserver(
			(seen) => {
				for (const entry of seen) {
					if (!entry.isIntersecting) continue;
					const a = entry.target as HTMLAnchorElement;
					inView.unobserve(a);
					void resolve(a).then((ref) => {
						// Nothing may only mean the server had not learned the repo yet.
						if (ref || retried.has(a)) return;
						retried.add(a);
						retries.add(setTimeout(() => a.isConnected && inView.observe(a), RETRY_MS));
					});
				}
			},
			{ rootMargin: '200px' }
		);
		const watch = (node: Node) => {
			if (!(node instanceof Element)) return;
			if (node.matches('a.gh-ref')) inView.observe(node);
			for (const a of node.querySelectorAll('a.gh-ref:not(.resolved)')) inView.observe(a);
		};
		const drawn = new MutationObserver((changes) => {
			for (const change of changes) {
				// What `drawChip` puts inside a chip holds no chip of its own.
				if ((change.target as Element).matches('a.gh-ref')) continue;
				change.addedNodes.forEach(watch);
			}
		});
		watch(el);
		drawn.observe(el, { childList: true, subtree: true });

		const listening = new AbortController();
		const { signal } = listening;
		el.addEventListener('pointerover', onPointerOver, { signal });
		el.addEventListener('pointerout', onPointerOut, { signal });
		el.addEventListener('pointerdown', onPointerDown, { signal });
		el.addEventListener('click', onClick, { signal });
		el.addEventListener('focusin', onFocusIn, { signal });
		el.addEventListener('focusout', hide, { signal });
		return () => {
			clearTimeout(timer);
			retries.forEach(clearTimeout);
			inView.disconnect();
			drawn.disconnect();
			listening.abort();
		};
	});
</script>

<Popover.Root bind:open>
	{#if shown && visual}
		<Popover.Content
			class="gh-card"
			customAnchor={anchor}
			side="top"
			align="start"
			sideOffset={6}
			trapFocus={false}
			onOpenAutoFocus={(e) => e.preventDefault()}
			onCloseAutoFocus={(e) => e.preventDefault()}
			onpointerenter={() => clearTimeout(timer)}
			onpointerleave={(e) => e.pointerType === 'mouse' && hide()}
		>
			<p class="gh-card-repo">
				<iconify-icon icon="mdi:github"></iconify-icon>
				{shown.repo}
				<span class="gh-card-num">#{shown.number}</span>
			</p>
			<p class="gh-card-title">{shown.title}</p>
			<p class="gh-card-meta">
				<span class="gh-card-state" style:--gh={visual.color}>
					<iconify-icon icon={visual.icon}></iconify-icon>
					{visual.label}
				</span>
				{#if shown.author}<span>{shown.author}</span>{/if}
				{#if ago}<span>{ago === 'now' ? 'updated just now' : `updated ${ago} ago`}</span>{/if}
			</p>
			<a class="gh-card-open" href={shown.url} target="_blank" rel="noopener">
				Open on GitHub
				<iconify-icon icon="mdi:open-in-new"></iconify-icon>
			</a>
		</Popover.Content>
	{/if}
</Popover.Root>
