<script lang="ts">
	/**
	 * The Web pane's Browser source: one tab of the remote browser a session
	 * drives, live, and open to the pointer, the keyboard and touch. Frames
	 * arrive over the stream and are drawn on a canvas scaled to the pane;
	 * what happens on the canvas goes back as input for the page. A desktop
	 * page is small on a phone, so two fingers (or Ctrl+wheel) magnify and
	 * move the picture on this side, and one finger is the page's.
	 *
	 * The tab shown is the one the session last opened or selected until the
	 * person picks another. The stream is open only while the pane is showing,
	 * because the server holds the tab's DevTools connection for exactly as
	 * long.
	 */
	import { onDestroy, untrack } from 'svelte';
	import * as Popover from '$lib/components/ui/popover';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Toggle } from '$lib/components/ui/toggle';
	import {
		buttonName,
		filterTabs,
		heldButton,
		keyMessage,
		modifiersOf,
		pickTab,
		textDelta,
		toPagePoint,
		UNZOOMED,
		zoomView,
		type BrowserInfo,
		type FrameSize,
		type View
	} from '$lib/side-panel/browser';
	import { BrowserStream } from '$lib/stores/browserStream.svelte';

	interface Props {
		sessionId: string | null;
		/** The pane is the one showing. */
		active: boolean;
		/** The tab the URL pins, if any. */
		tab: string | undefined;
		/** Pin a tab, or with null go back to following the session. */
		onPick: (id: string | null) => void;
		/** The URL of the tab being shown, for the pane's bar. */
		onUrl: (url: string | null) => void;
	}

	let { sessionId, active, tab, onPick, onUrl }: Props = $props();

	/** How often the tab list is read while the pane is showing. */
	const POLL_MS = 5_000;
	/** Two presses this close in time and place are a double click. */
	const MULTI_CLICK_MS = 500;
	const MULTI_CLICK_PX = 6;
	/** What one wheel notch scrolls when the wheel reports lines rather than pixels. */
	const LINE_PX = 40;

	// ── the tabs ─────────────────────────────────────────────────────────

	let info = $state<BrowserInfo | null>(null);
	let loading = $state(false);
	let infoSeq = 0;

	async function loadInfo() {
		const mine = ++infoSeq;
		loading = true;
		try {
			const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
			const res = await fetch(`/api/browser/tabs${q}`);
			const body = (await res.json()) as BrowserInfo;
			if (mine !== infoSeq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			// The session opened or selected another tab: the view goes with it.
			if (body.preferred && body.preferred !== followed) {
				followed = body.preferred;
				staying = null;
			}
			info = body;
		} catch (err) {
			if (mine !== infoSeq) return;
			info = { name: info?.name ?? 'the browser', error: `Could not ask claude-mux for the tabs: ${err}`, tabs: [], preferred: null };
		} finally {
			if (mine === infoSeq) loading = false;
		}
	}

	$effect(() => {
		void sessionId;
		if (!active) return;
		untrack(() => void loadInfo());
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void loadInfo();
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	/** The tab on show, kept while it stays open however its URL changes. */
	let staying = $state<string | null>(null);
	/** The session's tab as last reported, to tell when the session moves to another. */
	let followed: string | null = null;
	const current = $derived(pickTab(info, tab, staying));
	const currentId = $derived(current?.id ?? null);
	$effect(() => {
		if (currentId) staying = currentId;
	});

	let pickerOpen = $state(false);
	let query = $state('');
	const shown = $derived(filterTabs(info?.tabs ?? [], query));

	function pick(id: string) {
		// The session's own tab is followed rather than pinned, so the view moves on when the session does.
		onPick(id === info?.preferred ? null : id);
		staying = id;
		pickerOpen = false;
		query = '';
	}

	function hostOf(url: string): string {
		try {
			return new URL(url).host || url;
		} catch {
			return url;
		}
	}

	const labelOf = (t: { title: string; url: string }) => t.title || hostOf(t.url) || 'Untitled';

	// ── the stream ───────────────────────────────────────────────────────

	const stream = new BrowserStream();
	let canvas = $state<HTMLCanvasElement | null>(null);
	/** The remote viewport the canvas is showing, once a frame has been drawn. */
	let frame = $state<FrameSize | null>(null);
	let decodeSeq = 0;
	let drawnSeq = 0;

	stream.onFrame = (f) => {
		const seq = ++decodeSeq;
		const img = new Image();
		img.onload = () => {
			// Frames decode on their own time; an older one must not paint over a newer.
			if (seq < drawnSeq || !canvas) return;
			drawnSeq = seq;
			if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
			}
			canvas.getContext('2d')?.drawImage(img, 0, 0);
			if (frame?.width !== f.width || frame?.height !== f.height) frame = { width: f.width, height: f.height };
		};
		img.src = `data:image/jpeg;base64,${f.data}`;
	};

	$effect(() => {
		const id = currentId;
		if (active && id) {
			untrack(() => stream.open(id));
		} else {
			untrack(() => {
				stream.close();
				frame = null;
			});
		}
	});

	// Another tab starts from an empty canvas, not from the last tab's picture.
	$effect(() => {
		void currentId;
		untrack(() => {
			frame = null;
			// Frames of the last tab still decoding must not paint over this one.
			drawnSeq = decodeSeq + 1;
			view = UNZOOMED;
			touches.clear();
			pinch = null;
			pendingMove = null;
			clearTyped();
		});
	});

	// The canvas goes when the stream ends, and its frame with it.
	$effect(() => {
		if (stream.closedReason !== null) frame = null;
	});

	onDestroy(() => stream.close());

	$effect(() => {
		onUrl(stream.url ?? current?.url ?? null);
	});

	/** Reload the remote tab, or reconnect when the stream has ended. */
	export function reload() {
		if (!currentId || stream.closedReason !== null || info?.error) return retry();
		stream.input({ type: 'reload' });
	}

	function retry() {
		void loadInfo().then(() => {
			if (active && currentId) stream.open(currentId, true);
		});
	}

	// ── pointer, wheel and touch ─────────────────────────────────────────

	function at(e: { clientX: number; clientY: number }) {
		return canvas && frame ? toPagePoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), frame) : null;
	}

	let lastPress = { at: 0, x: 0, y: 0, count: 0, button: 0 };
	/** The fingers down, by pointer id: where each is in the page, and on this screen. */
	const touches = new Map<number, { x: number; y: number; sx: number; sy: number }>();

	/** How the picture is magnified on this side. The page itself is never zoomed. */
	let view = $state<View>(UNZOOMED);
	let stage = $state<HTMLDivElement | null>(null);
	/** A two-finger gesture in progress: the view and the fingers as it began. */
	let pinch: { view: View; mid: { x: number; y: number }; span: number } | null = null;

	/** `view` zoomed by `factor` so that what was under `from` lands on `to`, or as it was while nothing is drawn. */
	function zoomed(from: View, a: { x: number; y: number }, b: { x: number; y: number }, factor: number): View {
		if (!canvas || !stage) return from;
		const room = stage.getBoundingClientRect();
		const width = canvas.offsetWidth;
		const height = canvas.offsetHeight;
		// With no zoom the canvas sits centred in the stage at its laid-out size.
		const box = { left: room.left + (room.width - width) / 2, top: room.top + (room.height - height) / 2, width, height };
		return zoomView(from, a, b, factor, box, room);
	}

	function fingers() {
		const [a, b] = [...touches.values()];
		return { mid: { x: (a.sx + b.sx) / 2, y: (a.sy + b.sy) / 2 }, span: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1 };
	}
	/** A move waiting for the next animation frame, so a fast pointer sends one message per paint. */
	let pendingMove: Record<string, unknown> | null = null;

	function flushMove() {
		if (pendingMove) stream.input(pendingMove);
		pendingMove = null;
	}

	function sendMove(msg: Record<string, unknown>) {
		if (!pendingMove) requestAnimationFrame(flushMove);
		pendingMove = msg;
	}

	/** Put a finger where it now is, in the page and on this screen. */
	function track(e: PointerEvent, p: { x: number; y: number }) {
		touches.set(e.pointerId, { ...p, sx: e.clientX, sy: e.clientY });
	}

	function press(event: 'down' | 'up', e: PointerEvent, p: { x: number; y: number }) {
		stream.input({
			type: 'mouse',
			event,
			...p,
			// A cancelled pointer no longer says which button it was.
			button: buttonName(e.type === 'pointercancel' ? lastPress.button : e.button),
			buttons: e.buttons,
			clickCount: lastPress.count,
			modifiers: modifiersOf(e)
		});
	}

	function touchMessage(event: 'start' | 'move' | 'end' | 'cancel') {
		return { type: 'touch', event, points: [...touches].map(([id, p]) => ({ id, x: p.x, y: p.y })) };
	}

	function onPointerDown(e: PointerEvent) {
		const p = at(e);
		if (!p) return;
		canvas?.focus({ preventScroll: true });
		try {
			canvas?.setPointerCapture(e.pointerId);
		} catch {
			// a pointer that is already gone; the press still counts
		}
		flushMove();
		if (e.pointerType === 'touch') {
			// A second finger makes it a gesture on the picture, so the page's touch is called off.
			if (touches.size === 1 && !pinch) stream.input({ type: 'touch', event: 'cancel', points: [] });
			track(e, p);
			if (touches.size === 1 && !pinch) stream.input(touchMessage('start'));
			else if (touches.size === 2) pinch = { view, ...fingers() };
			return;
		}
		e.preventDefault();
		const again =
			e.timeStamp - lastPress.at < MULTI_CLICK_MS &&
			Math.abs(e.clientX - lastPress.x) < MULTI_CLICK_PX &&
			Math.abs(e.clientY - lastPress.y) < MULTI_CLICK_PX;
		lastPress = { at: e.timeStamp, x: e.clientX, y: e.clientY, count: again ? (lastPress.count % 3) + 1 : 1, button: e.button };
		press('down', e, p);
	}

	function onPointerMove(e: PointerEvent) {
		const p = at(e);
		if (!p) return;
		if (e.pointerType === 'touch') {
			if (!touches.has(e.pointerId)) return;
			track(e, p);
			if (!pinch) return sendMove(touchMessage('move'));
			if (touches.size === 2) {
				const now = fingers();
				view = zoomed(pinch.view, pinch.mid, now.mid, now.span / pinch.span);
			}
			return;
		}
		sendMove({ type: 'mouse', event: 'move', ...p, button: heldButton(e.buttons), buttons: e.buttons, modifiers: modifiersOf(e) });
	}

	function onPointerUp(e: PointerEvent) {
		flushMove();
		if (e.pointerType === 'touch') {
			if (!touches.delete(e.pointerId)) return;
			if (pinch) {
				// The gesture lasts until every finger is up; the one left behind does not become a touch.
				if (touches.size === 0) pinch = null;
				return;
			}
			stream.input(touchMessage(e.type === 'pointercancel' ? 'cancel' : 'end'));
			return;
		}
		// A cancelled press is still let go of, or the page is left holding the button.
		const p = at(e);
		if (p) press('up', e, p);
	}

	// A wheel listener has to be non-passive to keep the pane itself from scrolling.
	$effect(() => {
		const el = canvas;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			const p = at(e);
			if (!p) return;
			e.preventDefault();
			// Ctrl+wheel is also what a trackpad pinch sends. It magnifies the picture; the page's own zoom is left alone.
			if (e.ctrlKey) {
				const here = { x: e.clientX, y: e.clientY };
				view = zoomed(view, here, here, Math.exp(-e.deltaY * 0.01));
				return;
			}
			const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : 1;
			stream.input({ type: 'wheel', ...p, deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiersOf(e) });
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	// ── keys ─────────────────────────────────────────────────────────────

	function onKey(e: KeyboardEvent) {
		const msg = keyMessage(e, e.type === 'keyup' ? 'up' : 'down');
		if (!msg) return;
		e.preventDefault();
		stream.input(msg);
	}

	function onPaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData('text/plain');
		if (!text) return;
		e.preventDefault();
		stream.input({ type: 'text', text });
	}

	function pressKey(key: string, keyCode: number) {
		const e = { key, code: key, keyCode, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
		for (const event of ['down', 'up'] as const) {
			const msg = keyMessage(e, event);
			if (msg) stream.input(msg);
		}
	}

	/**
	 * A phone has no keys to forward until a text field has focus, so this
	 * field stands in: whatever is typed into it is typed into the page, and
	 * what it holds is only an echo of that.
	 */
	let typing = $state(false);
	let typedLocal = $state('');
	let typedRemote = '';
	let typingEl = $state<HTMLInputElement | null>(null);

	function mirrorTyped() {
		const { backspaces, insert } = textDelta(typedRemote, typedLocal);
		for (let i = 0; i < backspaces; i++) pressKey('Backspace', 8);
		if (insert) stream.input({ type: 'text', text: insert });
		typedRemote = typedLocal;
	}

	function onTypingKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			sendEnter();
		} else if (e.key === 'Backspace' && typedLocal === '') {
			pressKey('Backspace', 8);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			pressKey('Tab', 9);
			clearTyped();
		}
	}

	function clearTyped() {
		typedLocal = typedRemote = '';
	}

	function sendEnter() {
		pressKey('Enter', 13);
		clearTyped();
		typingEl?.focus();
	}

	$effect(() => {
		if (typing) typingEl?.focus();
	});
</script>

{#snippet failed(icon: string, heading: string, text: string)}
	<div class="empty">
		<iconify-icon {icon}></iconify-icon>
		<h3>{heading}</h3>
		<p>{text}</p>
		<Button size="sm" onclick={retry} disabled={loading}>
			<iconify-icon icon="mdi:refresh"></iconify-icon> Try again
		</Button>
	</div>
{/snippet}

<div class="browser">
	{#if info?.name && !info.error && info.tabs.length > 0}
		<div class="strip">
			<Popover.Root bind:open={pickerOpen}>
				<Popover.Trigger class="tab-trigger" aria-label="Choose a tab">
					<span class="live" class:on={stream.connected && frame !== null}></span>
					<span class="title">{current ? labelOf(current) : 'Untitled'}</span>
					<span class="count">{info.tabs.length} tabs</span>
					<iconify-icon icon="mdi:chevron-down"></iconify-icon>
				</Popover.Trigger>
				<Popover.Content class="tab-picker" align="start" sideOffset={4}>
					<Input bind:value={query} class="filter" type="search" placeholder="Find a tab…" aria-label="Find a tab" autocomplete="off" />
					<ul>
						{#each shown as t (t.id)}
							<li>
								<button type="button" class:current={t.id === currentId} onclick={() => pick(t.id)}>
									<span class="row1">
										<span class="t">{labelOf(t)}</span>
										{#if t.id === info.preferred}<Badge variant="secondary" title="The tab this session last opened or selected">Session</Badge>{/if}
									</span>
									<span class="u">{t.url}</span>
								</button>
							</li>
						{:else}
							<li class="none">No tab matches “{query}”.</li>
						{/each}
					</ul>
				</Popover.Content>
			</Popover.Root>
			<Toggle class="kbd" size="sm" variant="outline" bind:pressed={typing} title="Type into the page" aria-label="Type into the page">
				<iconify-icon icon="mdi:keyboard-outline"></iconify-icon>
			</Toggle>
		</div>
	{/if}

	<div class="stage" bind:this={stage}>
		{#if !info}
			<p class="msg dim">Looking for the browser's tabs…</p>
		{:else if !info.name}
			<div class="empty">
				<iconify-icon icon="mdi:monitor-off"></iconify-icon>
				<h3>No remote browser set up</h3>
				<p>
					This shows the browser a session drives through an MCP server started with
					<code>--browserUrl</code>. None is listed in <code>~/.claude.json</code>.
				</p>
			</div>
		{:else if info.error}
			{@render failed('mdi:lan-disconnect', "Can't reach the browser", info.error)}
		{:else if !current}
			<div class="empty">
				<iconify-icon icon="mdi:tab-unselected"></iconify-icon>
				<h3>No tabs open</h3>
				<p>The browser behind {info.name} is running with no page to show.</p>
			</div>
		{:else if stream.closedReason}
			{@render failed('mdi:tab-remove', 'The view ended', stream.closedReason)}
		{:else}
			{#if !frame}<p class="msg dim waiting">Connecting to {hostOf(current.url)}…</p>{/if}
			<canvas
				bind:this={canvas}
				class:blank={!frame}
				style:--ratio={frame ? frame.width / frame.height : 1.6}
				style:transform={view.scale === 1 ? null : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`}
				tabindex="0"
				aria-label={`Live view of ${current.title || current.url}`}
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
				oncontextmenu={(e) => e.preventDefault()}
				onkeydown={onKey}
				onkeyup={onKey}
				onpaste={onPaste}
			></canvas>
		{/if}
	</div>

	{#if typing && current && !info?.error}
		<form
			class="typing"
			onsubmit={(e) => {
				e.preventDefault();
				sendEnter();
			}}
		>
			<Input
				bind:ref={typingEl}
				bind:value={typedLocal}
				oninput={mirrorTyped}
				onkeydown={onTypingKey}
				class="field"
				type="text"
				placeholder="Tap a field in the page, then type here"
				aria-label="Type into the page"
				autocomplete="off"
				autocapitalize="off"
				autocorrect="off"
				spellcheck={false}
				enterkeyhint="enter"
			/>
			<Button type="submit" size="sm" variant="secondary" title="Press Enter in the page">
				<iconify-icon icon="mdi:keyboard-return"></iconify-icon> Enter
			</Button>
		</form>
	{/if}
</div>

<style>
	.browser {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.strip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border-bottom: 1px solid #222;
		flex: none;
	}
	.strip :global(.tab-trigger) {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 28px;
		padding: 0 8px 0 10px;
		border-radius: 6px;
		border: 1px solid #2a2a2a;
		background: #1a1a1a;
		color: #e7e5e4;
		font-size: 12px;
		text-align: left;
	}
	.strip :global(.tab-trigger:hover) {
		border-color: #3f3f46;
	}
	.strip :global(.tab-trigger:focus-visible) {
		outline: 2px solid #a8a29e;
		outline-offset: 1px;
	}
	.live {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #57534e;
	}
	.live.on {
		background: #34d399;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		flex: none;
		color: #78716c;
		font-size: 11px;
	}
	.strip :global(.kbd) {
		flex: none;
		height: 28px;
		border-color: #2a2a2a;
		color: #a8a29e;
		display: none;
	}
	.strip :global(.kbd[data-state='on']) {
		background: #e7e5e4;
		color: #0b0b0b;
	}
	/* Only a device with no keys of its own needs the field. */
	@media (pointer: coarse) {
		.strip :global(.kbd) {
			display: inline-flex;
		}
	}
	:global(.tab-picker) {
		width: min(420px, calc(100vw - 24px));
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	:global(.tab-picker .filter) {
		height: 32px;
		font-size: 13px;
	}
	:global(.tab-picker) ul {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: min(50vh, 380px);
		overflow-y: auto;
	}
	:global(.tab-picker) button {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	:global(.tab-picker) button:hover,
	:global(.tab-picker) button:focus-visible {
		background: #232326;
		outline: none;
	}
	:global(.tab-picker) button.current {
		background: #2a2a2e;
	}
	:global(.tab-picker) .row1 {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	:global(.tab-picker) .t {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		color: #f5f5f4;
	}
	:global(.tab-picker) .u {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #78716c;
	}
	:global(.tab-picker) .none {
		padding: 10px 8px;
		color: #78716c;
		font-size: 12.5px;
	}
	.stage {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		container-type: size;
		background: #0c0c0c;
		overflow: hidden;
	}
	canvas {
		/* The frame, as large as the pane allows at its own shape. */
		width: min(100cqw, calc(100cqh * var(--ratio)));
		aspect-ratio: var(--ratio);
		height: auto;
		background: #fff;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		outline: none;
		cursor: default;
	}
	canvas.blank {
		visibility: hidden;
	}
	canvas:focus-visible {
		box-shadow: inset 0 0 0 2px #a8a29e;
	}
	.waiting {
		position: absolute;
		inset: 0 auto auto 0;
	}
	.typing {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border-top: 1px solid #222;
		flex: none;
	}
	.typing :global(.field) {
		flex: 1;
		min-width: 0;
		height: 36px;
	}
	.msg {
		margin: 0;
		padding: 16px 18px;
		align-self: flex-start;
	}
	.empty {
		margin: auto;
		max-width: 420px;
		padding: 24px 20px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		text-align: center;
		line-height: 1.5;
	}
	.empty > iconify-icon {
		font-size: 30px;
		color: #57534e;
	}
	.empty h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: #e7e5e4;
	}
	.empty p {
		margin: 0;
		color: #a8a29e;
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.dim {
		color: #78716c;
	}
</style>
